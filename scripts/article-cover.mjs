// 文章封面：从站点视频截帧（或用图片），配上标题、分类标签，按版式排成 1200×630 的 JPG（og:image 的尺寸，见 site.seo.ogImageSize）。
// 用 Playwright 的 Chromium 渲染 HTML 再截图（e2e 已经装好），截帧需要本机 ffmpeg。用法：
//   node scripts/article-cover.mjs public/guides/<slug>.jpg [选项] <视频@秒 | 图片> …
// 选项：
//   --layout row|before-after|vs|hero|grid|full   版式，默认 row
//     row           1–3 帧扇形排开
//     before-after  两项：照片 → 成片，中间箭头
//     vs            两项：左右分屏，中间 VS
//     hero          一帧大图
//     grid          2–4 帧四宫格
//     full          一张横图铺满（如插画），文字压在左侧
//   --title "…"     标题（建议 2–6 个词，封面各语言共用，写英文）
//   --tag "…"       左上角分类标签，如 Guide、Compare、Fix、Ideas
//   --note "…"      标题下的一行小字
//   --labels "A|B"  before-after、vs 两项下面的说明
//   --accent "#hex" 强调色，默认 classic 主题的 --accent
// 不带 --title 时只排画面。生成后在 site.articles 对应文章里填 cover: '/guides/<文件名>'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
// 品牌名取运行目录（站点根目录）的 site.ts，不是脚本所在仓库的
const { site } = await import(pathToFileURL(resolve('src/config/site.ts')).href)

const W = 1200
const H = 630
const IMAGE = /\.(jpe?g|png|webp)$/i
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
const LAYOUTS = { row: [1, 3], 'before-after': [2, 2], vs: [2, 2], hero: [1, 1], grid: [2, 4], full: [1, 1] }

let work = ''
const fail = (message) => {
  if (work) rmSync(work, { recursive: true, force: true })
  console.error(message)
  process.exit(1)
}

const opts = { layout: 'row', title: '', tag: '', note: '', labels: '', accent: '#e0306f' }
const inputs = []
const argv = process.argv.slice(2)
const out = argv.shift()
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (!arg.startsWith('--')) {
    inputs.push(arg)
    continue
  }
  const name = arg.slice(2)
  if (!(name in opts) || argv[i + 1] === undefined) fail(`未知选项或缺少值：${arg}`)
  opts[name] = argv[++i]
}
const range = LAYOUTS[opts.layout]
if (!range) fail(`--layout 只能是 ${Object.keys(LAYOUTS).join('、')}`)
if (!out || !/\.jpe?g$/i.test(out) || inputs.length < range[0] || inputs.length > range[1]) {
  fail(`用法：node scripts/article-cover.mjs <输出.jpg> [选项] <视频@秒 | 图片> …（${opts.layout} 版式要 ${range.join('–')} 项，详见文件开头）`)
}

// 视频截一帧成 PNG，图片直接用；都转成 data URL 塞进 HTML
work = mkdtempSync(join(tmpdir(), 'article-cover-'))
const sources = inputs.map((input, i) => {
  const match = /^(.+)@(\d+(?:\.\d+)?)$/.exec(input)
  const file = match ? match[1] : input
  if (!existsSync(file)) fail(`找不到文件：${file}`)
  if (IMAGE.test(file)) return `data:${MIME[extname(file).toLowerCase()]};base64,${readFileSync(file).toString('base64')}`
  if (!match) fail(`视频要写成 <视频>@<秒>：${input}`)
  const png = join(work, `${i}.png`)
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', match[2], '-i', file, '-frames:v', '1', png], { stdio: 'inherit' })
  // ffmpeg 秒数超出视频时长时也以 0 退出，只是不写文件
  if (!existsSync(png)) fail(`没有截到帧：${input}（检查秒数是否超出视频时长）`)
  return `data:image/png;base64,${readFileSync(png).toString('base64')}`
})

const esc = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const hasText = Boolean(opts.title)
const labels = opts.labels ? opts.labels.split('|').map(esc) : []
const img = (src, cls = '', style = '') => `<img class="${cls}" style="${style}" src="${src}">`

// 画面区：有标题时在右侧，没有时占满
const area = hasText && opts.layout !== 'vs' ? { x: 560, w: 600 } : { x: 40, w: W - 80 }

function frames() {
  const n = sources.length
  switch (opts.layout) {
    case 'row': {
      // 9:16 竖帧，放不下时互相压一部分并带点倾斜
      const h = hasText ? 500 : 560
      const w = Math.round((h * 9) / 16)
      const step = n > 1 ? Math.min(w + 24, (area.w - w) / (n - 1)) : 0
      const x0 = area.x + (area.w - (w + step * (n - 1))) / 2
      const tilt = step < w + 24 ? 5 : 0
      return sources
        .map((src, i) => {
          const angle = n > 1 ? (i - (n - 1) / 2) * tilt : 0
          return img(src, 'card', `left:${x0 + i * step}px;top:${(H - h) / 2}px;width:${w}px;height:${h}px;transform:rotate(${angle}deg);z-index:${i === Math.floor(n / 2) ? 3 : 2}`)
        })
        .join('')
    }
    case 'before-after': {
      const h = 400
      const photoW = Math.round((h * 3) / 4)
      const videoW = Math.round((h * 9) / 16)
      const gap = 76
      const x0 = area.x + (area.w - photoW - gap - videoW) / 2
      const top = (H - h) / 2 - 16
      return [
        img(sources[0], 'card', `left:${x0}px;top:${top}px;width:${photoW}px;height:${h}px;transform:rotate(-3deg)`),
        `<div class="arrow" style="left:${x0 + photoW + (gap - 56) / 2}px;top:${top + h / 2 - 28}px">→</div>`,
        img(sources[1], 'card', `left:${x0 + photoW + gap}px;top:${top}px;width:${videoW}px;height:${h}px;transform:rotate(3deg)`),
        labels[0] ? `<div class="label" style="left:${x0}px;top:${top + h + 22}px;width:${photoW}px">${labels[0]}</div>` : '',
        labels[1] ? `<div class="label" style="left:${x0 + photoW + gap}px;top:${top + h + 22}px;width:${videoW}px">${labels[1]}</div>` : '',
      ].join('')
    }
    case 'vs':
      return [
        img(sources[0], 'half', 'left:0'),
        img(sources[1], 'half', `left:${W / 2}px`),
        '<div class="vs-shade"></div><div class="vs">VS</div>',
        labels[0] ? `<div class="label vs-label" style="left:0">${labels[0]}</div>` : '',
        labels[1] ? `<div class="label vs-label" style="left:${W / 2}px">${labels[1]}</div>` : '',
      ].join('')
    case 'hero': {
      const h = 560
      const w = Math.round((h * 9) / 16)
      return img(sources[0], 'card', `left:${area.x + (area.w - w) / 2}px;top:${(H - h) / 2}px;width:${w}px;height:${h}px;transform:rotate(2deg)`)
    }
    case 'grid': {
      const cols = 2
      const rows = n > 2 ? 2 : 1
      const gap = 16
      const cell = Math.min((area.w - gap * (cols - 1)) / cols, (H - 60 - gap * (rows - 1)) / rows)
      const x0 = area.x + (area.w - cell * cols - gap * (cols - 1)) / 2
      const y0 = (H - cell * rows - gap * (rows - 1)) / 2
      return sources
        .map((src, i) => img(src, 'card', `left:${x0 + (i % cols) * (cell + gap)}px;top:${y0 + Math.floor(i / cols) * (cell + gap)}px;width:${cell}px;height:${cell}px;object-position:center 30%`))
        .join('')
    }
    case 'full':
      return img(sources[0], 'full')
  }
}

const text = hasText
  ? `<div class="text${opts.layout === 'vs' ? ' text-vs' : ''}">
      ${opts.tag ? `<div class="tag">${esc(opts.tag)}</div>` : ''}
      <h1>${esc(opts.title)}</h1>
      ${opts.note ? `<p>${esc(opts.note)}</p>` : ''}
    </div>
    <div class="brand"><span></span>${esc(site.brandName)}</div>`
  : ''

const html = `<!doctype html><html><head><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: ${W}px; height: ${H}px; position: relative; overflow: hidden; background: #151311; color: #fbf8f2;
    font-family: ui-sans-serif, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif; }
  img { position: absolute; object-fit: cover; display: block; }
  .bg { inset: -40px; width: ${W + 80}px; height: ${H + 80}px; filter: blur(28px) brightness(0.5) saturate(1.2); }
  .full { inset: 0; width: ${W}px; height: ${H}px; }
  .shade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(14, 12, 10, 0.92) 0%, rgba(14, 12, 10, 0.7) 40%, rgba(14, 12, 10, 0) 72%); }
  .card { z-index: 2; border-radius: 18px; border: 3px solid rgba(255, 255, 255, 0.85); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5); }
  .half { top: 0; width: ${W / 2}px; height: ${H}px; object-position: center 30%; }
  .vs-shade { position: absolute; inset: 0; background: linear-gradient(0deg, rgba(14, 12, 10, 0.95) 0%, rgba(14, 12, 10, 0.55) 34%, rgba(14, 12, 10, 0) 60%); }
  .vs { position: absolute; left: ${W / 2 - 56}px; top: 150px; width: 112px; height: 112px; border-radius: 50%; background: ${opts.accent};
    border: 5px solid #fbf8f2; display: grid; place-items: center; font: 900 44px/1 ui-sans-serif, system-ui, sans-serif; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5); }
  .arrow { position: absolute; width: 56px; height: 56px; border-radius: 50%; background: ${opts.accent}; display: grid; place-items: center;
    font: 800 34px/1 ui-sans-serif, system-ui, sans-serif; z-index: 4; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); }
  .label { position: absolute; text-align: center; font-size: 22px; font-weight: 700; text-shadow: 0 2px 10px rgba(0, 0, 0, 0.7); }
  .vs-label { top: 28px; width: ${W / 2}px; font-size: 26px; }
  .text { position: absolute; left: 64px; top: 0; bottom: 0; width: 470px; display: flex; flex-direction: column; justify-content: center; gap: 22px; }
  .text-vs { top: auto; bottom: 64px; width: ${W - 128}px; align-items: center; text-align: center; gap: 14px; }
  .tag { align-self: flex-start; background: ${opts.accent}; padding: 8px 16px; border-radius: 999px; font-size: 18px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; }
  .text-vs .tag { align-self: center; }
  h1 { font-family: 'Iowan Old Style', 'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif; font-size: 62px; line-height: 1.04; font-weight: 700;
    text-wrap: balance; text-shadow: 0 3px 18px rgba(0, 0, 0, 0.5); }
  .text-vs h1 { font-size: 54px; }
  p { font-size: 24px; line-height: 1.35; color: rgba(251, 248, 242, 0.85); }
  .brand { position: absolute; left: 64px; bottom: 34px; font-size: 19px; font-weight: 700; letter-spacing: 0.04em; color: rgba(251, 248, 242, 0.8);
    display: flex; align-items: center; gap: 10px; }
  .brand span { width: 12px; height: 12px; border-radius: 50%; background: ${opts.accent}; }
  ${opts.layout === 'vs' ? '.brand { left: auto; right: 40px; bottom: 26px; font-size: 16px; }' : ''}
</style></head><body>
  ${opts.layout === 'full' || opts.layout === 'vs' ? '' : img(sources[0], 'bg')}
  ${hasText && opts.layout !== 'vs' ? '<div class="shade" style="z-index:1"></div>' : ''}
  ${frames()}
  <div style="position:absolute;inset:0;z-index:6">${text}</div>
</body></html>`

mkdirSync(dirname(out), { recursive: true })
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  await page.setContent(html)
  await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map((image) => image.decode())]))
  await page.screenshot({ path: out, type: 'jpeg', quality: 84 })
} finally {
  await browser.close()
  rmSync(work, { recursive: true, force: true })
}
console.log(`已生成 ${out}（${W}×${H}，${opts.layout}）`)
