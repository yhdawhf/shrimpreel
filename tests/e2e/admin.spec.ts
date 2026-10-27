import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { ORIGIN, buyPackage, clawbackCredits, credits, devLogin, json, ledger, pkg, post, uniqueEmail } from './helpers'

// wrangler.jsonc 的 ADMIN_EMAILS 默认包含此邮箱
const ADMIN_EMAIL = 'admin@example.com'

test('未登录与普通用户进不了后台，后台接口同样拒绝', async ({ page }) => {
  await page.goto('/admin')
  await expect(page.getByTestId('admin-denied')).toContainText('请先登录')
  expect((await page.request.get('/api/admin/stats')).status()).toBe(401)

  await devLogin(page.request, uniqueEmail('normal'))
  await page.goto('/admin/users')
  await expect(page.getByTestId('admin-denied')).toContainText('不是管理员')
  expect((await page.request.get('/api/admin/stats')).status()).toBe(403)
  expect((await post(page.request, '/api/admin/users/x/credits', { delta: 100, note: 'self' })).status()).toBe(403)
})

// 本地 Worker 读取的密钥（.dev.vars，没有时 wrangler 也不会注入）：只用于断言接口没有回传它们的值
function localSecrets() {
  if (!existsSync('.dev.vars')) return {}
  const pairs = readFileSync('.dev.vars', 'utf8')
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
  return Object.fromEntries(pairs.map((m) => [m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2')]))
}

test('后台概览显示上线配置检查：本地开发配置报错，接口只回传问题不回传密钥值', async ({ page }) => {
  await devLogin(page.request, ADMIN_EMAIL)
  const response = await page.request.get('/api/admin/stats')
  const body = await response.text()
  const { config } = JSON.parse(body) as { config: { level: string; key: string; message: string }[] }
  expect(config).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ level: 'error', key: 'APP_ENV' }),
      expect.objectContaining({ level: 'error', key: 'PAYMENT_PROVIDER' }),
      expect.objectContaining({ level: 'error', key: 'SITE_URL' }),
    ]),
  )
  // 本地 Worker 的绑定齐全：缺绑定说明代码与 wrangler.jsonc 脱节
  expect(config.map((i) => i.key)).not.toContain('bindings')
  const leaked = Object.entries(localSecrets())
    .filter(([, value]) => value.length >= 8 && body.includes(value))
    .map(([name]) => name)
  expect(leaked).toEqual([])

  await page.goto('/admin')
  const card = page.getByTestId('admin-config')
  await expect(card).toContainText('上线配置检查')
  await expect(card).toContainText('APP_ENV=development')
  await expect(card).toContainText('npm run doctor')
})

test('管理员调整积分与封禁：余额、流水、审计、会话同步生效', async ({ page, playwright }) => {
  const target = await playwright.request.newContext({ baseURL: ORIGIN })
  try {
    const user = await devLogin(target, uniqueEmail('target'))
    const admin = await devLogin(page.request, ADMIN_EMAIL)
    expect(admin.role).toBe('admin')
    page.on('dialog', (dialog) => dialog.accept())

    await page.goto(`/admin/users/${user.id}`)
    await expect(page.getByTestId('admin-user-credits')).toHaveText('0')
    await page.getByTestId('admin-delta').fill('15')
    await page.getByTestId('admin-note').fill('e2e 补偿')
    await page.getByTestId('admin-adjust').click()
    await expect(page.getByTestId('admin-user-credits')).toHaveText('15')

    expect(await credits(target)).toBe(15)
    expect((await ledger(target)).map((e) => [e.reason, e.delta])).toEqual([['admin_adjust', 15]])

    // 扣成负数被拒绝，余额不变
    const over = await json<{ error: string }>(post(page.request, `/api/admin/users/${user.id}/credits`, { delta: -100, note: 'too much' }), 400)
    expect(over.error).toBe('insufficient_credits')
    expect(await credits(target)).toBe(15)

    // 封禁后该用户的会话立即失效
    await page.getByTestId('admin-ban').click()
    await expect(page.getByRole('button', { name: '解封' })).toBeVisible()
    const me = await json<{ user: unknown }>(target.get('/api/me'))
    expect(me.user).toBeNull()

    await page.goto('/admin/audit')
    const audit = page.getByTestId('admin-audit')
    await expect(audit).toContainText(`user:${user.id}`)
    await expect(audit.locator('tbody tr').filter({ hasText: user.id })).toHaveCount(2)
  } finally {
    await target.dispose()
  }
})

// 支付商后台已退款但 webhook 丢失 → 后台"仅记账"补登；之后同一退款单号的 webhook 迟到，不得再回收一次积分
test('管理员退款：参数校验、补登后迟到的同号 webhook 不重复扣、退剩余后订单关闭', async ({ page, playwright }) => {
  const buyer = await playwright.request.newContext({ baseURL: ORIGIN })
  try {
    await devLogin(buyer, uniqueEmail('admin-refund'))
    const starter = pkg('starter')
    const partialCents = Math.min(330, starter.priceCents - 1) // 补登的部分退款金额，模板价 $9.90 下是 $3.30
    const partial = clawbackCredits(starter, partialCents)
    const orderId = await buyPackage(buyer, 'starter')
    await devLogin(page.request, ADMIN_EMAIL)
    const refund = (data: Record<string, unknown>) => post(page.request, `/api/admin/orders/${orderId}/refund`, data)
    const rejected = async (data: Record<string, unknown>, status = 400) => (await json<{ error: string }>(refund(data), status)).error
    type OrderView = { status: string; refundedAmountCents: number; refundedCredits: number }
    const orderView = async () => (await json<{ order: OrderView }>(buyer.get(`/api/orders/${orderId}`))).order

    expect(await rejected({ amountCents: partialCents })).toBe('note_required')
    expect(await rejected({ note: 'e2e', amountCents: starter.priceCents + 1 })).toBe('invalid_amount')
    expect(await rejected({ note: 'e2e', amountCents: 0 })).toBe('invalid_amount')
    expect(await rejected({ note: 'e2e', amountCents: 3.3 })).toBe('invalid_amount')
    expect(await credits(buyer)).toBe(starter.credits)

    // 补登部分金额：按金额比例回收（公式同服务端 planRefund）
    const refundId = `${orderId}_late`
    const local = await json<{ requested: boolean; refunded: boolean }>(refund({ note: 'webhook 丢失补登', amountCents: partialCents, mode: 'local', refundId }))
    expect(local).toMatchObject({ requested: false, refunded: true })
    expect(await credits(buyer)).toBe(starter.credits - partial)
    expect(await orderView()).toMatchObject({ status: 'paid', refundedAmountCents: partialCents, refundedCredits: partial })

    // 同号 webhook 迟到：判为 duplicate，积分与订单记账都不变
    const late = await json<{ status: string }>(post(buyer, '/api/mock-payments/complete', { orderId, outcome: 'refunded', eventId: refundId, amountCents: partialCents }))
    expect(late.status).toBe('duplicate')
    expect(await credits(buyer)).toBe(starter.credits - partial)
    expect(await orderView()).toMatchObject({ refundedAmountCents: partialCents, refundedCredits: partial })

    // 不填金额 = 退剩余金额，回收剩余积分，订单转 refunded，之后不能再退
    expect(await json<{ refunded: boolean }>(refund({ note: '退剩余' }))).toMatchObject({ refunded: true })
    expect(await credits(buyer)).toBe(0)
    expect(await orderView()).toMatchObject({ status: 'refunded', refundedAmountCents: starter.priceCents, refundedCredits: starter.credits })
    expect(await rejected({ note: '再退一次' }, 409)).toBe('order_not_paid')
    expect((await ledger(buyer)).filter((e) => e.reason === 'order_refund').map((e) => e.delta).sort((a, b) => a - b)).toEqual([-(starter.credits - partial), -partial].sort((a, b) => a - b))

    await page.goto('/admin/audit')
    await expect(page.getByTestId('admin-audit').locator('tbody tr').filter({ hasText: orderId })).toHaveCount(2)
  } finally {
    await buyer.dispose()
  }
})
