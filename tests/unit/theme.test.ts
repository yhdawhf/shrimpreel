import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { site } from '#/config/site'
import { THEMES, THEME_COLOR } from '#/lib/theme'

const css = readFileSync('src/styles.css', 'utf8')

// classic 用 :root 和 [data-theme='dark']；其它主题只靠 [data-skin] 覆盖变量，漏写暗色一组会沿用亮色值
describe('主题', () => {
  it('site.theme 是已登记的主题', () => {
    expect(THEMES).toContain(site.theme)
  })

  it.each(THEMES.filter((name) => name !== 'classic'))('%s 在 styles.css 里同时定义了亮色和暗色', (name) => {
    expect(css).toContain(`[data-skin='${name}'] {`)
    expect(css).toContain(`[data-skin='${name}'][data-theme='dark'] {`)
    expect(THEME_COLOR[name]).toMatch(/^#[0-9a-f]{6}$/)
  })
})
