import { describe, expect, it } from 'vitest'
import { ARTICLES, formatPrice, sellingPlans, site } from '#/config/site'
import { absoluteUrl } from '#/lib/i18n'
import { isSeoPath, seoRoutes } from '#/server/seo'

describe('llms.txt', () => {
  const fetchLlms = () => seoRoutes.request('/llms.txt', {}, {} as unknown as Env)

  it('是 text/plain，H1 是品牌名，被 server.ts 识别为 SEO 路径', async () => {
    const res = await fetchLlms()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect((await res.text()).split('\n')[0]).toBe(`# ${site.brandName}`)
    expect(isSeoPath('/llms.txt')).toBe(true)
  })

  it('每篇文章的绝对 URL、价格、时长和积分都与配置一致，没有 TODO', async () => {
    const text = await (await fetchLlms()).text()
    for (const article of ARTICLES) expect(text).toContain(`(${absoluteUrl(`/${article.slug}`)})`)
    for (const p of site.packages) expect(text).toContain(`${p.credits} credits for ${formatPrice(p.priceCents, p.currency)}`)
    for (const d of site.durations) expect(text).toContain(`${d.seconds}-second clip: ${d.credits} credit`)
    for (const p of sellingPlans) expect(text).toContain(`${formatPrice(p.priceCents, p.currency)} per ${p.interval}`)
    expect(text).toContain(`kept for ${site.retention.outputDays} days`)
    expect(text).not.toContain('TODO')
  })
})
