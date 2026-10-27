import { ArrowRight } from 'lucide-react'
import type { Article } from '#/config/site'
import { useContent, useLocale } from '#/lib/i18n'
import { LocalLink, formatDay } from './ui'

// 文章卡片列表：/guides 与文章页的“相关指南”共用。整张卡片是一个 <a>，标题即链接文字
export function ArticleCards({ articles, headingLevel }: { articles: readonly Article[]; headingLevel: 2 | 3 }) {
  const c = useContent()
  const locale = useLocale()
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {articles.map((article) => {
        const text = c.articles[article.key]
        return (
          <li key={article.key}>
            <LocalLink to={`/${article.slug}`} className="card group flex h-full flex-col overflow-hidden transition hover:border-fg/40">
              {/* 标题紧跟在后面，封面对读屏是重复信息，alt 留空 */}
              {article.cover ? (
                <img src={article.cover} alt="" width={1200} height={630} loading="lazy" className="aspect-[1200/630] w-full border-b border-line object-cover" />
              ) : null}
              <div className="flex flex-1 flex-col gap-3 p-6">
                <Heading className="font-display text-xl leading-snug group-hover:text-accent-text">{text.title}</Heading>
                <p className="text-sm leading-6 text-muted">{text.description}</p>
                <span className="mt-auto flex items-center justify-between pt-2 text-xs text-muted">
                  <time dateTime={article.updatedAt}>{formatDay(article.updatedAt, locale)}</time>
                  <ArrowRight className="size-4" aria-hidden />
                </span>
              </div>
            </LocalLink>
          </li>
        )
      })}
    </ul>
  )
}
