import { expect, test, type APIRequestContext } from '@playwright/test'
import { site } from '../../src/config/site'
import { ORIGIN, buyPackage, content, credits, devLogin, json, ledger, pkg, post, uniqueEmail } from './helpers'

type Referral = { enabled: true; code: string; url: string; rewardCredits: number; invited: number; rewarded: number; credits: number }
type Recent = { inviteeId: string; inviterId: string; status: string; rejectReason: string | null; orderId: string | null; credits: number | null }

const ADMIN_EMAIL = 'admin@example.com'
const REWARD = site.referralRewardCredits

// 访问邀请链接：302 回首页并种下 vt_ref cookie（同一个 request context 里后续注册会带上）
async function visitInvite(request: APIRequestContext, code: string) {
  const res = await request.get(`/i/${code}`, { maxRedirects: 0 })
  expect(res.status()).toBe(302)
  expect(res.headers()['location']).toBe('/?ref=invite')
  expect(res.headers()['x-robots-tag']).toBe('noindex')
  return res.headers()['set-cookie'] ?? ''
}

async function referralRow(admin: APIRequestContext, inviteeId: string) {
  const data = await json<{ recent: Recent[] }>(admin.get('/api/admin/referrals?days=0'))
  return data.recent.find((row) => row.inviteeId === inviteeId)
}

// 邀请全流程：设置页拿链接 → 好友经链接注册 → 首单付款给邀请人发奖励 → 第二单不再发 → 首单退款回收奖励；后台能看到记录
test('邀请奖励：好友经链接注册并首单付款，邀请人得积分；第二单不再发，首单退款回收；无效码和老用户不绑定', async ({ page, playwright }) => {
  const contexts: APIRequestContext[] = []
  const newContext = async () => {
    const context = await playwright.request.newContext({ baseURL: ORIGIN })
    contexts.push(context)
    return context
  }
  try {
    // 邀请人在设置页看到自己的邀请链接
    const inviterEmail = uniqueEmail('inviter')
    const inviter = await devLogin(page.request, inviterEmail)
    await page.goto('/dashboard/settings')
    await expect(page.getByTestId('referral-card')).toContainText(content.en.settings.referralTitle)
    const url = await page.getByTestId('referral-link').inputValue()
    expect(url).toMatch(new RegExp(`^${ORIGIN}/i/[A-HJ-NP-Z2-9]{8}$`))
    await expect(page.getByTestId('referral-stats')).toHaveText(content.en.settings.referralStats(0, 0, 0))
    const code = url.split('/i/')[1]!
    // 邀请码一经生成不变
    expect((await json<Referral>(page.request.get('/api/referral'))).code).toBe(code)

    // 好友经链接注册（小写码也认）
    const friend = await newContext()
    expect(await visitInvite(friend, code.toLowerCase())).toContain('vt_ref=')
    const friendUser = await devLogin(friend, uniqueEmail('invitee'))
    // 注册时消费掉 cookie：再登录别的账号不会重复绑定
    expect((await friend.storageState()).cookies.find((c) => c.name === 'vt_ref')).toBeUndefined()

    // 无效码不种 cookie；老用户访问邀请链接后登录不绑定
    const stranger = await newContext()
    expect(await visitInvite(stranger, 'NOTACODE1')).not.toContain('vt_ref=')
    const strangerUser = await devLogin(stranger, uniqueEmail('stranger'))
    const veteranEmail = uniqueEmail('veteran')
    const veteran = await newContext()
    await devLogin(veteran, veteranEmail)
    expect(await visitInvite(veteran, code)).toContain('vt_ref=')
    const veteranUser = await devLogin(veteran, veteranEmail)

    await devLogin(page.request, ADMIN_EMAIL)
    expect(await referralRow(page.request, friendUser.id)).toMatchObject({ inviterId: inviter.id, status: 'pending', orderId: null })
    expect(await referralRow(page.request, strangerUser.id)).toBeUndefined()
    expect(await referralRow(page.request, veteranUser.id)).toBeUndefined()
    expect(await referralRow(page.request, inviter.id)).toBeUndefined()

    // 首单付款：好友拿到套餐积分，邀请人得奖励，流水 ref 是订单
    const inviterContext = await newContext()
    await devLogin(inviterContext, inviterEmail)
    const first = await buyPackage(friend, 'starter')
    expect(await credits(friend)).toBe(pkg('starter').credits)
    expect(await credits(inviterContext)).toBe(REWARD)
    expect((await ledger(inviterContext)).map((e) => [e.reason, e.delta, e.ref_id])).toEqual([['referral', REWARD, first]])
    expect(await json<Referral>(inviterContext.get('/api/referral'))).toMatchObject({ invited: 1, rewarded: 1, credits: REWARD })

    // 第二单不再发；没被邀请的用户付款不影响邀请人
    await buyPackage(friend, 'starter')
    await buyPackage(stranger, 'starter')
    expect(await credits(inviterContext)).toBe(REWARD)

    // 首单退款：好友的套餐积分和邀请人的奖励都回收；退款重放不重复回收
    const refund = () => post(friend, '/api/mock-payments/complete', { orderId: first, outcome: 'refunded', eventId: `${first}_refund` })
    expect((await json<{ status: string }>(refund())).status).toBe('processed')
    expect((await json<{ status: string }>(refund())).status).toBe('duplicate')
    expect(await credits(friend)).toBe(pkg('starter').credits)
    expect(await credits(inviterContext)).toBe(0)
    expect((await ledger(inviterContext)).map((e) => [e.reason, e.delta, e.ref_id])).toEqual([
      ['referral_refund', -REWARD, first],
      ['referral', REWARD, first],
    ])
    expect(await json<Referral>(inviterContext.get('/api/referral'))).toMatchObject({ invited: 1, rewarded: 0, credits: 0 })
    expect(await referralRow(page.request, friendUser.id)).toMatchObject({ status: 'reversed', orderId: first, credits: REWARD })

    // 导出我的数据：双方只看到自己这一侧，不含对方的 ID、邮箱和 IP 哈希
    const inviterExport = await (await inviterContext.get('/api/account/export')).text()
    expect(JSON.parse(inviterExport)).toMatchObject({
      account: { referralCode: code },
      referredBy: [],
      referralsSent: [{ status: 'reversed', rewardCredits: REWARD, rejectReason: null }],
    })
    const friendExport = await (await friend.get('/api/account/export')).text()
    expect(JSON.parse(friendExport)).toMatchObject({ referredBy: [{ status: 'reversed' }], referralsSent: [] })
    for (const leaked of [friendUser.id, 'ip_hash', 'ipHash']) expect(inviterExport, leaked).not.toContain(leaked)
    for (const leaked of [inviter.id, inviterEmail, code, 'ip_hash', 'ipHash']) expect(friendExport, leaked).not.toContain(leaked)

    // 后台邀请排行页：最近邀请里能看到这条记录和回收状态
    await page.goto('/admin/referrals')
    await page.getByLabel('时间范围').selectOption('0')
    const row = page.locator(`[data-testid="admin-referral-row"][data-invitee="${friendUser.id}"]`)
    await expect(row).toContainText('已回收')
    await expect(row).toContainText(inviterEmail)
    await expect(page.getByTestId('admin-referral-leaders')).toBeVisible()

    // 非管理员看不到后台数据
    expect((await friend.get('/api/admin/referrals')).status()).toBe(403)
  } finally {
    for (const context of contexts) await context.dispose()
  }
})

// 同一个 IP 经同一个邀请人注册超过上限：超出的记为 rejected（ip_limit），付款也不发奖励
test('邀请奖励：同一 IP 注册超过上限的不发奖励，后台显示拒绝原因', async ({ page, playwright }) => {
  const inviterEmail = uniqueEmail('ip-inviter')
  await devLogin(page.request, inviterEmail)
  const { code } = await json<Referral>(page.request.get('/api/referral'))

  // 本地开发只放行回环地址，用 cf-connecting-ip: 127.0.0.1 模拟同一个 IP
  const invitees: string[] = []
  let last: APIRequestContext | null = null
  for (let i = 0; i <= site.referralMaxPerIp; i++) {
    const context = await playwright.request.newContext({ baseURL: ORIGIN, extraHTTPHeaders: { 'cf-connecting-ip': '127.0.0.1' } })
    await visitInvite(context, code)
    invitees.push((await devLogin(context, uniqueEmail(`ip-${i}`))).id)
    if (last) await last.dispose()
    last = context
  }
  try {
    // 超出上限的那个付款：邀请人拿不到奖励
    await buyPackage(last!, 'starter')
    expect(await credits(page.request)).toBe(0)
    expect(await json<Referral>(page.request.get('/api/referral'))).toMatchObject({ invited: site.referralMaxPerIp + 1, rewarded: 0 })

    await devLogin(page.request, ADMIN_EMAIL)
    const rows = await Promise.all(invitees.map((id) => referralRow(page.request, id)))
    expect(rows.slice(0, -1).map((row) => row?.status)).toEqual(Array(site.referralMaxPerIp).fill('pending'))
    expect(rows.at(-1)).toMatchObject({ status: 'rejected', rejectReason: 'ip_limit', orderId: null })

    await page.goto('/admin/referrals')
    await expect(page.locator(`[data-testid="admin-referral-row"][data-invitee="${invitees.at(-1)}"]`)).toContainText('同一 IP 超出上限')
  } finally {
    await last?.dispose()
  }
})
