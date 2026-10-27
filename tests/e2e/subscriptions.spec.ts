import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { buyPackage, credits, devLogin, json, ledger, ORIGIN, pkg, plan, post, uniqueEmail, yearlySavingPercent } from './helpers'

const MONTHLY = plan('monthly').credits
const YEARLY = plan('yearly').credits

type Result = { status: 'processed' | 'duplicate' | 'ignored' | 'orphan' | 'mismatch'; note?: string; orderId?: string }
type Sub = { status: string; cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null; nextGrantAt: string | null; planId: string }
type OrderView = { id: string; status: string; packageId: string; credits: number; subscriptionId: string | null }

const DAY = 86400_000

// 模拟支付商的续费扣款和订阅状态 webhook（作用于当前用户最近的 mock 订阅）
const subEvent = (request: APIRequestContext, action: string, extra: Record<string, unknown> = {}) =>
  json<Result & { subscription: Sub | null }>(post(request, '/api/mock-payments/subscription', { action, ...extra }))
const subscription = async (request: APIRequestContext) => (await json<{ subscription: Sub | null }>(request.get('/api/subscription'))).subscription
const orders = async (request: APIRequestContext) => (await json<{ orders: OrderView[] }>(request.get('/api/orders'))).orders
const checkout = (request: APIRequestContext, packageId: string) => post(request, '/api/checkout', { packageId, locale: 'en' })

async function shot(page: Page, name: string) {
  // 按钮切换时有 CSS 过渡，关掉动画避免拍到中间态
  const body = await page.screenshot({ path: `.tmp/subscriptions/${name}.png`, fullPage: true, animations: 'disabled' })
  await test.info().attach(name, { body, contentType: 'image/png' })
}

test('月付：定价页订阅、积分当月作废、续费新建订单、扣款失败与恢复、到期取消与撤销、终止后可重新订阅', async ({ page }) => {
  const request = page.request
  await devLogin(request, uniqueEmail('sub-monthly'))
  await page.goto('/pricing')
  // 年付折扣：与定价页同一公式；没有可比的月付（积分不同）时不显示
  const saving = yearlySavingPercent(plan('yearly'))
  if (saving) await expect(page.getByTestId('plan-yearly')).toContainText(`Save ${saving}%`)
  else await expect(page.getByTestId('plan-yearly')).not.toContainText(/Save \d+%/)
  await expect(page.getByTestId('buy-yearly')).toBeEnabled()
  await shot(page, 'pricing')
  await page.getByTestId('buy-monthly').click()
  await page.getByTestId('mock-pay').click()
  await expect(page.getByTestId('checkout-result')).toHaveAttribute('data-status', 'paid')
  expect(await credits(request)).toBe(MONTHLY)

  // 订阅积分带到期时间（当期结束），不是永久积分
  const sub = (await subscription(request))!
  expect(sub).toMatchObject({ status: 'active', planId: 'monthly', cancelAtPeriodEnd: false, nextGrantAt: null })
  const { expiring } = await json<{ expiring: Array<{ credits: number; expiresAt: string }> }>(request.get('/api/credits/expiring'))
  expect(expiring).toEqual([{ credits: MONTHLY, expiresAt: sub.currentPeriodEnd }])

  // 同一时间只能有一个订阅；还会续费时不能注销（否则支付商会继续扣款）
  expect((await json<{ error: string }>(checkout(request, 'yearly'), 409)).error).toBe('subscription_exists')
  expect((await json<{ error: string }>(request.delete('/api/account', { headers: { origin: ORIGIN } }), 409)).error).toBe('subscription_active')

  // 续费：新订单，重放不重复入账；金额不符只记待处理订单
  const renewEventId = `renew_${Date.now()}`
  expect((await subEvent(request, 'renew', { eventId: renewEventId })).status).toBe('processed')
  expect((await subEvent(request, 'renew', { eventId: renewEventId })).status).toBe('duplicate')
  expect(await credits(request)).toBe(MONTHLY * 2)
  expect((await subEvent(request, 'renew')).status).toBe('processed')
  expect(await credits(request)).toBe(MONTHLY * 3)
  const list = await orders(request)
  expect(list.filter((o) => o.packageId === 'monthly' && o.status === 'paid')).toHaveLength(3)
  expect(new Set(list.map((o) => o.subscriptionId)).size).toBe(1)
  expect((await subEvent(request, 'renew', { paidAmountCents: 1 })).status).toBe('mismatch')
  expect(await credits(request)).toBe(MONTHLY * 3)

  // 扣款失败：账单页提示更新付款方式；支付商重试成功后恢复
  await subEvent(request, 'past_due')
  await page.goto('/dashboard/billing')
  await expect(page.getByTestId('subscription-card')).toHaveAttribute('data-status', 'past_due')
  await expect(page.getByTestId('subscription-past-due')).toBeVisible()
  await shot(page, 'billing-past-due')
  await subEvent(request, 'renew')
  expect((await subscription(request))!.status).toBe('active')

  // 本站取消续费 → 显示到期日；撤销取消 → 恢复续费提示
  await page.reload()
  await expect(page.getByTestId('subscription-renews')).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByTestId('subscription-cancel').click()
  await expect(page.getByTestId('subscription-ends')).toBeVisible()
  await shot(page, 'billing-canceling')
  await page.getByTestId('subscription-resume').click()
  await expect(page.getByTestId('subscription-renews')).toBeVisible()
  await shot(page, 'billing-active')

  // 门户（mock 回到账单页）
  await page.getByTestId('subscription-portal').click()
  await expect(page).toHaveURL(/\/dashboard\/billing#mock-portal$/)

  // 支付商终止订阅后：卡片显示已结束，可以重新订阅
  await subEvent(request, 'canceled')
  await page.goto('/dashboard/billing')
  await expect(page.getByTestId('subscription-card')).toHaveAttribute('data-status', 'canceled')
  await expect(page.getByTestId('subscription-cancel')).toHaveCount(0)
  await shot(page, 'billing-ended')
  await json(checkout(request, 'monthly'))
})

test('年付：按月补发（重复执行不重发）、状态事件乱序、退款只回收订阅积分并停止补发', async ({ request }) => {
  await devLogin(request, uniqueEmail('sub-yearly'))
  const { orderId } = await json<{ orderId: string }>(checkout(request, 'yearly'))
  await json(post(request, '/api/mock-payments/complete', { orderId, outcome: 'paid', eventId: `${orderId}_paid` }))
  expect(await credits(request)).toBe(YEARLY)
  const sub = (await subscription(request))!
  expect(sub).toMatchObject({ status: 'active', planId: 'yearly' })
  expect(Date.parse(sub.nextGrantAt!) - Date.now()).toBeGreaterThan(27 * DAY)

  const grant = (days: number) => json<{ checked: number; granted: number; credits: number }>(post(request, '/api/dev/subscription-grants', { days }))
  expect(await grant(0)).toMatchObject({ granted: 0, credits: YEARLY })
  expect(await grant(31)).toMatchObject({ granted: 1, credits: YEARLY * 2 })
  expect(await grant(31)).toMatchObject({ granted: 0, credits: YEARLY * 2 })
  const order = (await orders(request)).find((o) => o.id === orderId)!
  expect(order).toMatchObject({ status: 'paid', credits: YEARLY * 2 })

  // 先到达的“更晚事件”生效，迟到的更早事件被忽略
  const later = new Date(Date.now() + 60_000).toISOString()
  const earlier = new Date(Date.now() + 30_000).toISOString()
  expect((await subEvent(request, 'cancel_at_period_end', { occurredAt: later })).status).toBe('processed')
  const stale = await subEvent(request, 'past_due', { occurredAt: earlier })
  expect(stale).toMatchObject({ status: 'ignored', subscription: { status: 'active', cancelAtPeriodEnd: true } })
  // 已取消续费：允许注销前的检查放行，这里不真的注销

  // 另买的积分包不受订阅退款影响
  await buyPackage(request, 'starter')
  expect(await credits(request)).toBe(YEARLY * 2 + pkg('starter').credits)
  expect((await json<Result>(post(request, '/api/mock-payments/complete', { orderId, outcome: 'refunded', eventId: `${orderId}_refund` }))).status).toBe(
    'processed',
  )
  expect(await credits(request)).toBe(pkg('starter').credits)
  const refund = (await ledger(request)).find((e) => e.reason === 'order_refund')
  expect(refund).toMatchObject({ delta: -YEARLY * 2, ref_id: orderId })

  // 当期订单已退款：之后不再补发
  expect(await grant(62)).toMatchObject({ granted: 0, credits: pkg('starter').credits })
  expect((await subscription(request))!.nextGrantAt).toBeNull()
})
