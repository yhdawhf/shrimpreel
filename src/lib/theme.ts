// 主题：site.theme 选一套，写在 <html data-skin>；颜色、字体、圆角在 src/styles.css 的 [data-skin] 里定义。
// 亮色 / 暗色由 data-theme 另外控制（访客切换），每套主题都要同时定义两种
//   classic：暖白纸张 + 品红强调、衬线标题、胶囊按钮
//   acid：锌黑 / 奶白 + 黄绿强调、无衬线粗标题、小圆角按钮
export const THEMES = ['classic', 'acid'] as const
export type ThemeName = (typeof THEMES)[number]

// <meta name="theme-color">（手机浏览器地址栏颜色），取各主题亮色模式的背景
export const THEME_COLOR: Record<ThemeName, string> = {
  classic: '#f7f4ee',
  acid: '#f5f3ee',
}
