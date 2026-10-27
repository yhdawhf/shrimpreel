import { Link } from '@tanstack/react-router'
import { LoaderCircle, Sparkles } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { LOCALE_META, site, type Locale } from '#/config/site'
import { useContent, useLocalePath } from '#/lib/i18n'

// 站内链接：自动加语言前缀，走客户端路由。
// to 已是解析后的真实路径；显式传空 params，避免从 $slug 页链接到另一篇文章时沿用当前 params 导致 SSR 卡死
export function LocalLink({ to, children, ...rest }: Omit<ComponentProps<'a'>, 'href'> & { to: string; children: ReactNode }) {
  const lp = useLocalePath()
  return (
    <Link to={lp(to) as never} params={{} as never} {...rest}>
      {children}
    </Link>
  )
}

export function LogoMark({ className = 'size-9 text-sm' }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-xl bg-(image:--logo-bg) font-bold tracking-tight text-(--logo-fg) shadow-sm ${className}`}
    >
      {site.logoMark}
    </span>
  )
}

export function Logo() {
  return (
    <LocalLink to="/" className="flex items-center gap-2.5">
      <LogoMark />
      <span className="brand-name">{site.brandName}</span>
    </LocalLink>
  )
}

// 可见面包屑，items 与 breadcrumbJsonLd 用同一份（结构化数据必须对应页面上可见的内容）；最后一项是当前页
export function Breadcrumbs({ items }: { items: Array<{ name: string; path: string }> }) {
  const c = useContent()
  const trail = [{ name: c.meta.breadcrumbHome, path: '/' }, ...items]
  return (
    <nav aria-label={c.common.breadcrumb} className="mb-6 text-sm text-muted">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {trail.map((item, index) => (
          <li key={item.path} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden>/</span> : null}
            {index === trail.length - 1 ? (
              <span aria-current="page">{item.name}</span>
            ) : (
              <LocalLink to={item.path} className="hover:text-accent-text">
                {item.name}
              </LocalLink>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

export function GoogleIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}

export function Spinner({ className = 'size-4' }: { className?: string }) {
  return <LoaderCircle className={`animate-spin ${className}`} aria-hidden />
}

// 成片上的“AI 生成”标识（透明度披露）；父元素需要 relative
export function AiBadge() {
  const label = useContent().common.aiGenerated
  return (
    <span
      data-testid="ai-badge"
      className="pointer-events-none absolute top-2 left-2 z-10 inline-flex items-center gap-1 rounded-md bg-black/70 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-white"
    >
      <Sparkles className="size-3" aria-hidden /> {label}
    </span>
  )
}

export function ErrorText({ code }: { code: string | null }) {
  const errors = useContent().errors
  if (!code) return null
  // code 可能来自地址栏（/sign-in?error=），只认文案表自己的键，避免 __proto__ 之类取到原型属性
  return (
    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
      {Object.hasOwn(errors, code) ? errors[code] : errors.internal_error}
    </p>
  )
}

export function StatusPill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'muted'; children: ReactNode }) {
  const tones = {
    ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    bad: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    muted: 'bg-bg-soft text-muted',
  }
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
}

export function formatDate(value: string | null | undefined, locale: Locale) {
  if (!value) return '—'
  return new Intl.DateTimeFormat(LOCALE_META[locale].tag, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

// 只有日期（YYYY-MM-DD）：按 UTC 格式化，服务端与浏览器结果一致，不会因时区差一天
export function formatDay(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(LOCALE_META[locale].tag, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))
}
