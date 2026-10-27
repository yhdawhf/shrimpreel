import { expect, test, type Page } from '@playwright/test'
import { formatPrice } from '#/config/site'
import { ORIGIN, buyPackage, clawbackCredits, content, credits, devLogin, json, pkg, post, uniqueEmail } from './helpers'

// wrangler.jsonc 的 ADMIN_EMAILS 默认包含此邮箱
const ADMIN_EMAIL = 'admin@example.com'
const t = content.en.billing

const starter = pkg('starter')
const PRICE = formatPrice(starter.priceCents, starter.currency)
// 部分退款金额：模板价 $9.90 下是 $3.30；回收积分按服务端同一公式
const PARTIAL_CENTS = Math.min(330, starter.priceCents - 1)
const PARTIAL = formatPrice(PARTIAL_CENTS, starter.currency)
const CLAWBACK = clawbackCredits(starter, PARTIAL_CENTS)

// 后台操作用 prompt / confirm / alert：prompt 按队列依次回答，alert 记下来供断言
function dialogs(page: Page) {
  const answers: string[] = []
  const alerts: string[] = []
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'alert') alerts.push(dialog.message())
    await dialog.accept(dialog.type() === 'prompt' ? (answers.shift() ?? '') : undefined)
  })
  return { answers, alerts }
}

async function failedOrder(request: Parameters<typeof buyPackage>[0]) {
  const { orderId } = await json<{ orderId: string }>(post(request, '/api/checkout', { packageId: 'starter', locale: 'en' }))
  await json(post(request, '/api/mock-payments/complete', { orderId, outcome: 'failed' }))
  return orderId
}

test('用户账单与订单详情：实付与部分退款展示，他人订单接口与页面都拿不到', async ({ page, browser, playwright }) => {
  await devLogin(page.request, uniqueEmail('billing'))
  const orderId = await buyPackage(page.request, 'starter')
  const unpaidId = await failedOrder(page.request)

  await page.goto('/dashboard/billing')
  const row = page.getByTestId('orders-table').locator('tbody tr').filter({ has: page.getByTestId(`order-details-${orderId}`) })
  await expect(row).toContainText(PRICE)
  await expect(row).toContainText(t.orderStatus.paid!)
  await row.getByTestId(`order-details-${orderId}`).click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/orders/${orderId}$`))
  await expect(page.getByTestId('order-detail-id')).toHaveText(orderId)
  await expect(page.getByTestId('order-detail-paid')).toHaveText(PRICE)
  await expect(page.getByText(t.order.mockNote)).toBeVisible()

  // 支付商回调部分退款：按金额比例回收积分，账单和详情都显示退款
  await json(post(page.request, '/api/mock-payments/complete', { orderId, outcome: 'refunded', eventId: `${orderId}_r1`, amountCents: PARTIAL_CENTS }))
  await page.reload()
  await expect(page.getByTestId('order-detail-refunded')).toHaveText(t.refundedLine(PARTIAL, CLAWBACK))
  await expect(page.getByTestId('order-detail')).toContainText(t.orderStatus.partially_refunded!)
  await page.goto('/dashboard/billing')
  await expect(page.getByTestId('orders-table')).toContainText(t.refundedLine(PARTIAL, CLAWBACK))

  // 未支付订单：没有实付金额，提示被扣款时联系客服
  await page.goto(`/dashboard/orders/${unpaidId}`)
  await expect(page.getByTestId('order-detail')).toContainText(t.orderStatus.failed!)
  await expect(page.getByText(t.order.mockNote)).toBeVisible()

  // 中文路由同样可用
  await page.goto(`/zh/dashboard/orders/${orderId}`)
  await expect(page.getByRole('heading', { name: content.zh.billing.order.title })).toBeVisible()

  // 其他用户：用户接口 404、后台接口 403，页面显示找不到
  const other = await playwright.request.newContext({ baseURL: ORIGIN })
  const otherContext = await browser.newContext()
  try {
    await devLogin(other, uniqueEmail('billing-other'))
    expect((await other.get(`/api/orders/${orderId}`)).status()).toBe(404)
    expect((await other.get(`/api/admin/orders/${orderId}`)).status()).toBe(403)
    const otherPage = await otherContext.newPage()
    await devLogin(otherPage.request, uniqueEmail('billing-other-page'))
    await otherPage.goto(`${ORIGIN}/dashboard/orders/${orderId}`)
    await expect(otherPage.getByTestId('order-detail-error')).toContainText(content.en.errors.not_found!)
    await expect(otherPage.getByTestId('order-detail')).toHaveCount(0)
  } finally {
    await other.dispose()
    await otherContext.close()
  }
})

test('后台订单详情：搜索进入、金额校验失败可重试、部分退款与补单后时间线完整', async ({ page, playwright }) => {
  const buyer = await playwright.request.newContext({ baseURL: ORIGIN })
  try {
    await devLogin(buyer, uniqueEmail('admin-order'))
    const orderId = await buyPackage(buyer, 'starter')
    const unpaidId = await failedOrder(buyer)
    await devLogin(page.request, ADMIN_EMAIL)
    expect((await page.request.get('/api/admin/orders/ord_missing')).status()).toBe(404)
    const { answers, alerts } = dialogs(page)

    await page.goto('/admin/orders')
    // 列表是客户端请求的，出现即说明页面已水合，再提交搜索不会退化成原生表单提交
    await expect(page.getByTestId('admin-orders').locator('tbody tr').first()).toBeVisible()
    await page.getByPlaceholder('订单号 / 邮箱 / 支付商流水号').fill(orderId)
    await page.getByRole('button', { name: '搜索' }).click()
    await expect(page.getByTestId('admin-orders').locator('tbody tr')).toHaveCount(1)
    await page.getByTestId(`order-link-${orderId}`).click()
    await expect(page).toHaveURL(new RegExp(`/admin/orders/${orderId}$`))
    const detail = page.getByTestId('admin-order-detail')
    await expect(detail).toContainText(PRICE)

    // 超过可退金额：前端拦下并提示，订单不变
    answers.push('99')
    await page.getByTestId(`refund-${orderId}`).click()
    await expect.poll(() => alerts.at(-1)).toBe('退款金额无效')
    await expect(page.getByTestId('admin-order-refunded')).toHaveText('$0.00 · 0 积分')

    // 重试：部分退款（mock 订单走仅记账），按比例回收积分
    answers.push((PARTIAL_CENTS / 100).toFixed(2), 'e2e 部分退款')
    await page.getByTestId(`refund-${orderId}`).click()
    await expect(page.getByTestId('admin-order-refunded')).toHaveText(`${PARTIAL} · ${CLAWBACK} 积分`)
    await expect(detail).toContainText('部分退款')
    expect(await credits(buyer)).toBe(starter.credits - CLAWBACK)

    const timeline = page.getByTestId('order-timeline')
    await expect(timeline).toContainText('创建订单（mock）')
    await expect(timeline).toContainText('mock.paid')
    await expect(timeline).toContainText(`purchase +${starter.credits}`)
    await expect(timeline).toContainText(`order_refund -${CLAWBACK}`)
    await expect(timeline).toContainText(`order.refund（${ADMIN_EMAIL}）`)
    // 付款成功邮件由回调异步入队；没配邮件服务时记为“未发送”，同样出现在时间线
    await expect
      .poll(async () => (await json<{ emails: { template: string }[] }>(page.request.get(`/api/admin/orders/${orderId}`))).emails.map((e) => e.template))
      .toContain('order_paid')
    await page.reload()
    await expect(timeline).toContainText('order_paid →')

    // 失败订单补单：发放积分，状态转已支付，时间线有补单记录
    await page.goto(`/admin/orders/${unpaidId}`)
    await expect(page.getByTestId('admin-order-detail')).toContainText('失败')
    answers.push('支付商后台已核实 e2e')
    await page.getByTestId(`mark-paid-${unpaidId}`).click()
    await expect(page.getByTestId('admin-order-detail')).toContainText('已支付')
    await expect(timeline).toContainText('mock.failed')
    await expect(timeline).toContainText(`order.mark_paid（${ADMIN_EMAIL}）`)
    expect(await credits(buyer)).toBe(starter.credits * 2 - CLAWBACK)
  } finally {
    await buyer.dispose()
  }
})

test('后台用户：付费 / 封禁筛选、按积分排序、详情汇总与审计', async ({ page, playwright }) => {
  const tag = `filter-${Date.now()}`
  const contexts = await Promise.all([0, 1, 2].map(() => playwright.request.newContext({ baseURL: ORIGIN })))
  try {
    const [payerCtx, bannedCtx, plainCtx] = contexts as [typeof contexts[0], typeof contexts[0], typeof contexts[0]]
    const payer = await devLogin(payerCtx, uniqueEmail(`${tag}-payer`))
    const banned = await devLogin(bannedCtx, uniqueEmail(`${tag}-banned`))
    const plain = await devLogin(plainCtx, uniqueEmail(`${tag}-plain`))
    const orderId = await buyPackage(payerCtx, 'starter')
    await devLogin(page.request, ADMIN_EMAIL)
    await json(post(page.request, `/api/admin/users/${banned.id}/status`, { status: 'banned' }))

    type Row = { id: string; paid_orders: number; status: string }
    const list = async (query: string) => (await json<{ users: Row[] }>(page.request.get(`/api/admin/users?q=${tag}&${query}`))).users
    expect((await list('paying=1')).map((u) => [u.id, u.paid_orders])).toEqual([[payer.id, 1]])
    expect((await list('status=banned')).map((u) => u.id)).toEqual([banned.id])
    expect((await list('sort=credits'))[0]!.id).toBe(payer.id)
    expect((await list('role=admin')).length).toBe(0)
    // 非法排序值回落到注册时间倒序，不拼进 SQL
    expect((await list('sort=credits;DROP')).map((u) => u.id)).toEqual([plain.id, banned.id, payer.id])

    await page.goto('/admin/users')
    const rows = page.getByTestId('admin-users').locator('tbody tr')
    await expect(rows.first()).toBeVisible()
    await page.getByPlaceholder('邮箱或用户 ID').fill(tag)
    await page.getByRole('button', { name: '搜索' }).click()
    await expect(rows).toHaveCount(3)
    await page.getByLabel('付费').selectOption('1')
    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText(payer.email)
    await page.getByLabel('付费').selectOption('')
    await page.getByLabel('状态').selectOption('banned')
    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText(banned.email)

    await page.goto(`/admin/users/${payer.id}`)
    await expect(page.getByTestId('admin-user-summary')).toContainText(PRICE)
    await expect(page.getByTestId('admin-user-summary')).toContainText('1 笔付款')
    await page.getByTestId('admin-user-orders').getByRole('link', { name: orderId }).click()
    await expect(page).toHaveURL(new RegExp(`/admin/orders/${orderId}$`))

    await page.goto(`/admin/users/${banned.id}`)
    await expect(page.getByTestId('admin-user-summary')).toContainText('未付过款')
    await expect(page.getByTestId('admin-user-audit')).toContainText('user.ban')
  } finally {
    await Promise.all(contexts.map((c) => c.dispose()))
  }
})

test('积分明细超过一页：加载更多后条目完整且不重复', async ({ page, playwright }) => {
  const user = await devLogin(page.request, uniqueEmail('ledger-pages'))
  const admin = await playwright.request.newContext({ baseURL: ORIGIN })
  try {
    await devLogin(admin, ADMIN_EMAIL)
    // 55 条流水 = 1 页 50 + 第 2 页 5；note 带序号便于检查重复
    for (let i = 1; i <= 55; i++) await json(post(admin, `/api/admin/users/${user.id}/credits`, { delta: 1, note: `e2e #${i}` }))
  } finally {
    await admin.dispose()
  }
  expect(await credits(page.request)).toBe(55)

  await page.goto('/dashboard/billing')
  const rows = page.getByTestId('ledger-table').locator('tbody tr')
  await expect(rows).toHaveCount(50)
  await expect(page.getByText(t.noOrders)).toBeVisible()
  await expect(page.getByTestId('orders-load-more')).toHaveCount(0)
  await page.getByTestId('ledger-load-more').click()
  await expect(rows).toHaveCount(55)
  await expect(page.getByTestId('ledger-load-more')).toHaveCount(0)

  // 两页拼起来正好是全部 55 条，没有重复也没有遗漏
  const api = await json<{ entries: { id: string }[] }>(page.request.get('/api/credits/ledger?page=2'))
  expect(api.entries).toHaveLength(5)
  const first = await json<{ entries: { id: string }[] }>(page.request.get('/api/credits/ledger?page=1'))
  expect(new Set([...first.entries, ...api.entries].map((e) => e.id)).size).toBe(55)
})
