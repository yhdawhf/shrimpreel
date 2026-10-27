import { useRouterState } from '@tanstack/react-router'
import { useState } from 'react'
import { site } from '#/config/site'
import { api, errorCode } from '#/lib/api'
import { track } from '#/lib/attribution'
import { useLocale, useLocalePath } from '#/lib/i18n'
import { signInHref, useSession } from '#/lib/session'

// 价格页和生成器共用的下单逻辑：未登录跳登录，已登录 POST /api/checkout（只传套餐 id 和语言）后跳收银台
export function useCheckout() {
  const locale = useLocale()
  const lp = useLocalePath()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { user, config, loading } = useSession()
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 后台暂停收款时所有人都看到说明；按钮只对管理员保持可点，便于验证
  const checkoutPaused = !!config?.notice.checkoutPaused
  const paused = checkoutPaused && user?.role !== 'admin'

  async function buy(packageId: string) {
    if (!user) {
      location.href = signInHref(config, pathname, lp('/sign-in'))
      return
    }
    setError(null)
    setPending(packageId)
    const pack = site.packages.find((p) => p.id === packageId) ?? site.plans.find((p) => p.id === packageId)
    if (pack) {
      track('begin_checkout', {
        value: pack.priceCents / 100,
        currency: pack.currency,
        items: [{ item_id: pack.id, item_name: pack.id, quantity: 1 }],
      })
    }
    try {
      const data = await api<{ orderId: string; url: string }>('/api/checkout', { json: { packageId, locale } })
      location.href = data.url
    } catch (err) {
      setError(errorCode(err))
      setPending(null)
    }
  }

  return { buy, pending, error, checkoutPaused, paused, loading }
}
