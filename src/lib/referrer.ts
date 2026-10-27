// 中转页：Google 登录、支付商结账页回跳时 document.referrer 是这些域名，访客其实是从本站出发又回来的，
// 不能记成来源（否则 accounts.google.com 会被当成 google organic）。客户端不记、服务端按 direct 归类，两边共用这份表。
const TRANSIT_HOSTS = [
  /^accounts\.google\./,
  /^accounts\.youtube\.com$/,
  /(^|\.)dodopayments\.com$/,
  /(^|\.)waffo\.(ai|com)$/,
  /(^|\.)stripe\.com$/,
  /(^|\.)paypal\.com$/,
]

export const isTransitHost = (host: string) => TRANSIT_HOSTS.some((pattern) => pattern.test(host.toLowerCase()))
