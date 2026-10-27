import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { ORIGIN, credits, devLogin, json, pkg, post, uniqueEmail } from './helpers'

const STARTER = pkg('starter').credits
const PARTY = pkg('party').credits

// wrangler.jsonc 的 ADMIN_EMAILS 默认包含此邮箱
const ADMIN_EMAIL = 'admin@example.com'

type Sweep = { checked: number } & Record<string, number>
type Reconciled = { reconcile: string; order: { status: string }; credits: number }

async function createOrder(request: APIRequestContext, packageId: string) {
  return (await json<{ orderId: string }>(post(request, '/api/checkout', { packageId, locale: 'en' }))).orderId
}

// 模拟“支付商已收款，但 webhook 丢失”：只在 mock 支付商那边记下付款，不触发入账
async function payWithoutWebhook(request: APIRequestContext, orderId: string, extra: Record<string, unknown> = {}) {
  const result = await json<{ status: string }>(post(request, '/api/mock-payments/complete', { orderId, deliver: false, ...extra }))
  expect(result.status).toBe('stored')
}

function alerts(page: Page) {
  const messages: string[] = []
  page.on('dialog', async (dialog) => {
    messages.push(dialog.message())
    await dialog.accept()
  })
  return messages
}

test('webhook 丢失：成功页久等未到账时主动查单，订单入账并显示成功', async ({ page }) => {
  await devLogin(page.request, uniqueEmail('reconcile-page'))
  const orderId = await createOrder(page.request, 'starter')
  await payWithoutWebhook(page.request, orderId)

  await page.goto(`/checkout/success?order=${orderId}`)
  const result = page.getByTestId('checkout-result')
  await expect(result).toHaveAttribute('data-status', 'pending')
  // 约 15 秒时触发第一次查单
  await expect(result).toHaveAttribute('data-status', 'paid', { timeout: 30_000 })
  await expect(result).toContainText(String(STARTER))
  expect(await credits(page.request)).toBe(STARTER)
})

test('Cron 对账与查单接口：退避、并发只入账一次、迟到 webhook 不重复、越权与金额不符不自动处理', async ({ page, playwright }) => {
  const buyer = await playwright.request.newContext({ baseURL: ORIGIN })
  const other = await playwright.request.newContext({ baseURL: ORIGIN })
  try {
    await devLogin(buyer, uniqueEmail('reconcile'))
    await devLogin(other, uniqueEmail('reconcile-other'))
    const sweep = async (minutes: number) => json<Sweep>(post(buyer, '/api/dev/reconcile-sweep', { minutes }))
    const reconcile = (request: APIRequestContext, orderId: string) => post(request, `/api/orders/${orderId}/reconcile`)

    const lost = await createOrder(buyer, 'party')
    await payWithoutWebhook(buyer, lost)
    const unpaid = await createOrder(buyer, 'starter')

    // 创建不到 10 分钟不查（成功页轮询和 webhook 还在路上）；别人的订单查不了，也看不出订单是否存在
    expect(await sweep(5)).toEqual({ checked: 0 })
    expect((await json<{ error: string }>(reconcile(other, lost), 404)).error).toBe('not_found')
    expect(await credits(buyer)).toBe(0)

    expect(await sweep(11)).toEqual({ checked: 2, processed: 1, unpaid: 1 })
    expect(await credits(buyer)).toBe(PARTY)
    // 指数退避：未付订单要等年龄翻倍（11 → 22 分钟）才再查
    expect(await sweep(15)).toEqual({ checked: 0 })
    expect(await sweep(23)).toEqual({ checked: 1, unpaid: 1 })
    expect((await json<{ order: { status: string } }>(buyer.get(`/api/orders/${unpaid}`))).order.status).toBe('pending')

    // 原本丢失的 webhook 迟到：订单已入账，不重复加积分
    const late = await json<{ status: string }>(post(buyer, '/api/mock-payments/complete', { orderId: lost, outcome: 'paid', eventId: `${lost}_late` }))
    expect(late.status).toBe('duplicate')
    expect(await credits(buyer)).toBe(PARTY)

    // 同一订单 5 个查单请求同时到达：只有一个真正查支付商并入账
    const racy = await createOrder(buyer, 'starter')
    await payWithoutWebhook(buyer, racy)
    const results = await Promise.all([0, 1, 2, 3, 4].map(() => json<Reconciled>(reconcile(buyer, racy))))
    // 其余请求：占不到查单时间返回 throttled，读到订单时已入账则返回 skipped
    expect(results.filter((r) => r.reconcile === 'processed')).toHaveLength(1)
    expect(results.every((r) => ['processed', 'throttled', 'skipped'].includes(r.reconcile))).toBe(true)
    expect(await credits(buyer)).toBe(PARTY + STARTER)
    expect((await json<Reconciled>(reconcile(buyer, racy))).reconcile).toBe('skipped')

    // 查到的付款金额不足：和 webhook 一样记为不符、不入账，之后 Cron 不再自动查（只剩 unpaid 一单被查）
    const short = await createOrder(buyer, 'starter')
    await payWithoutWebhook(buyer, short, { paidAmountCents: Math.min(100, pkg('starter').priceCents - 1) })
    const shortResult = await json<Reconciled>(reconcile(buyer, short))
    expect(shortResult).toMatchObject({ reconcile: 'mismatch', order: { status: 'pending' }, credits: PARTY + STARTER })
    expect(await sweep(60)).toEqual({ checked: 1, unpaid: 1 })

    // 后台查单：不符的订单提示人工核对；webhook 丢失的订单查到即入账，时间线有对账事件和审计
    const adminLost = await createOrder(buyer, 'starter')
    await payWithoutWebhook(buyer, adminLost)
    await devLogin(page.request, ADMIN_EMAIL)
    const messages = alerts(page)
    await page.goto(`/admin/orders/${short}`)
    await page.getByTestId(`reconcile-${short}`).click()
    await expect.poll(() => messages.at(-1)).toContain('已有金额/商品不符的付款事件')

    await page.goto(`/admin/orders/${adminLost}`)
    await page.getByTestId(`reconcile-${adminLost}`).click()
    await expect.poll(() => messages.at(-1)).toContain('已按正常流程入账')
    await expect(page.getByTestId('admin-order-detail')).toContainText('已支付')
    const timeline = page.getByTestId('order-timeline')
    await expect(timeline).toContainText('reconcile')
    await expect(timeline).toContainText(`order.reconcile（${ADMIN_EMAIL}）`)
    expect(await credits(buyer)).toBe(PARTY + STARTER * 2)
  } finally {
    await buyer.dispose()
    await other.dispose()
  }
})
