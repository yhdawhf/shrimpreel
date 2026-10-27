import { describe, expect, it } from 'vitest'
import { anchorPrice, cheapestPackageCovering, packageMakes, site, type CreditPackage } from '#/config/site'

const pack = (fields: { priceCents: number; anchorPriceCents?: number }) => ({ id: 'starter', credits: 20, currency: 'USD', ...fields }) as unknown as CreditPackage

// 划线原价只在填了真实原价且高于售价时出现；填错（等于或低于售价）不能显示成“打折”
describe('anchorPrice', () => {
  it('没填原价时不显示', () => {
    expect(anchorPrice(pack({ priceCents: 990 }))).toBeNull()
  })

  it('原价等于或低于售价时不显示', () => {
    expect(anchorPrice(pack({ priceCents: 990, anchorPriceCents: 990 }))).toBeNull()
    expect(anchorPrice(pack({ priceCents: 990, anchorPriceCents: 500 }))).toBeNull()
  })

  it('原价高于售价时返回原价和四舍五入的折扣百分比', () => {
    expect(anchorPrice(pack({ priceCents: 1990, anchorPriceCents: 2990 }))).toEqual({ cents: 2990, percentOff: 33 })
    expect(anchorPrice(pack({ priceCents: 990, anchorPriceCents: 1980 }))).toEqual({ cents: 1980, percentOff: 50 })
  })
})

// 价格卡“能做几条”：最长的买得起的时长 + 最短时长（相同则一项），随 site.durations 推导
describe('packageMakes', () => {
  const shortest = site.durations[0]!
  const longest = site.durations[site.durations.length - 1]!

  it('一个时长都买不起时为空', () => {
    expect(packageMakes(0)).toEqual([])
    expect(packageMakes(shortest.credits - 1)).toEqual([])
  })

  it('刚好够最短时长时只列一项', () => {
    expect(packageMakes(shortest.credits)).toEqual([{ videos: 1, seconds: shortest.seconds }])
  })

  it('够最长时长时列最长和最短两项', () => {
    const credits = longest.credits * 2
    expect(packageMakes(credits)).toEqual([
      { videos: 2, seconds: longest.seconds },
      { videos: Math.floor(credits / shortest.credits), seconds: shortest.seconds },
    ])
  })
})

// 生成器就地购买：选积分够补缺口的最便宜的包
describe('cheapestPackageCovering', () => {
  it('返回积分 ≥ 缺口且价格最低的包；缺口大于所有包时为 undefined', () => {
    const max = Math.max(...site.packages.map((p) => p.credits))
    const found = cheapestPackageCovering(1)!
    expect(found.priceCents).toBe(Math.min(...site.packages.map((p) => p.priceCents)))
    expect(cheapestPackageCovering(max + 1)).toBeUndefined()
  })
})
