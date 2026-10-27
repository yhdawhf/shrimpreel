import { createFileRoute, notFound } from '@tanstack/react-router'
import { ArticleCards } from '#/components/ArticleCards'
import { Breadcrumbs, formatDay } from '#/components/ui'
import { findArticle, relatedArticles, site } from '#/config/site'
import { absoluteUrl, getContent, localeFromParam, pageHead, useContent, useLocale, useLocalePath } from '#/lib/i18n'
import { articleJsonLd, breadcrumbJsonLd, jsonLdScript } from '#/lib/seo'

// SEO 文章：slug 来自 site.articles。非文章 slug 不参与匹配，这样 /zh 会落到中文首页而不是被当成 slug
export const Route = createFileRoute('/{-$locale}/$slug')({
  params: {
    parse: (raw) => (findArticle(raw.slug) ? raw : false),
  },
  loader: ({ params }) => {
    const article = findArticle(params.slug)
    if (!article) throw notFound()
    return { article }
  },
  head: ({ params, loaderData }) => {
    if (!loaderData) return {}
    const { article } = loaderData
    const locale = localeFromParam(params.locale)
    const c = getContent(locale)
    const text = c.articles[article.key]
    const path = `/${article.slug}`
    const head = pageHead(locale, path, `${text.title} | ${site.brandName}`, text.description)
    return {
      ...head,
      meta: [
        ...head.meta,
        { property: 'og:type', content: 'article' },
        { property: 'article:published_time', content: article.publishedAt },
        { property: 'article:modified_time', content: article.updatedAt },
        // 覆盖根路由的 og:image（同名 meta 去重后留下这里的）；宽高跟着重写，保证排在 og:image 后面。封面固定 1200×630
        ...(article.cover
          ? [
              { property: 'og:image', content: absoluteUrl(article.cover) },
              { property: 'og:image:width', content: String(site.seo.ogImageSize.width) },
              { property: 'og:image:height', content: String(site.seo.ogImageSize.height) },
              { name: 'twitter:image', content: absoluteUrl(article.cover) },
            ]
          : []),
      ],
      scripts: [
        jsonLdScript(articleJsonLd(locale, path, text, article)),
        jsonLdScript(breadcrumbJsonLd(locale, c.meta.breadcrumbHome, breadcrumbItems(c, text.title, path))),
      ],
    }
  },
  component: ArticlePage,
})

function breadcrumbItems(c: ReturnType<typeof getContent>, title: string, path: string) {
  return [
    { name: c.guides.title, path: '/guides' },
    { name: title, path },
  ]
}

function ArticlePage() {
  const { article } = Route.useLoaderData()
  const c = useContent()
  const locale = useLocale()
  const lp = useLocalePath()
  const text = c.articles[article.key]
  const related = relatedArticles(article)
  return (
    <article className="container-page max-w-3xl py-16">
      <Breadcrumbs items={breadcrumbItems(c, text.title, `/${article.slug}`)} />
      <h1 className="font-display text-5xl leading-tight">{text.title}</h1>
      <p className="mt-4 text-sm text-muted">
        {c.common.lastUpdated}: <time dateTime={article.updatedAt}>{formatDay(article.updatedAt, locale)}</time>
      </p>
      {article.cover ? (
        <img
          src={article.cover}
          alt={text.title}
          width={1200}
          height={630}
          fetchPriority="high"
          className="mt-8 aspect-[1200/630] w-full rounded-2xl border border-line object-cover"
        />
      ) : null}
      <p className="mt-6 text-xl leading-9 text-muted">{text.intro}</p>
      <div className="prose-article mt-6">
        {text.sections.map((section) => (
          <section key={section.h}>
            <h2>{section.h}</h2>
            {section.p.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </section>
        ))}
      </div>
      <div className="card mt-12 flex flex-col items-start gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="font-display text-2xl">{c.finalCta.title}</p>
        <a href={`${lp('/')}#create`} className="btn-primary shrink-0">
          {c.finalCta.cta}
        </a>
      </div>
      {related.length ? (
        <aside className="mt-14" aria-labelledby="related-guides">
          <h2 id="related-guides" className="mb-5 font-display text-2xl">
            {c.guides.related}
          </h2>
          <ArticleCards articles={related} headingLevel={3} />
        </aside>
      ) : null}
    </article>
  )
}
