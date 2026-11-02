/**
 * Just enough RSS 2.0 and Atom to read a news feed: title, link, id, summary, date and
 * categories. No dependency, no network: the caller fetches, this only reads.
 */
export interface FeedItem {
  id: string
  title: string
  link?: string
  summary: string
  at?: number
  tags: string[]
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCodePoint(Number(name.slice(1)))
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

/** Plain text from a bit of HTML: tags and scripts removed, whitespace folded. */
export function plain(html: string): string {
  // CDATA holds raw HTML; anything else is HTML escaped once into XML. Unwrap, unescape to get
  // the HTML, strip its markup, then decode the HTML's own entities once.
  const unwrapped = html.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  const markup = /<!\[CDATA\[/.test(html) ? unwrapped : decode(unwrapped)
  return decode(
    markup
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/** Feeds end their summaries with "follow us on WeChat"; that is not part of the news. */
export function withoutPromotion(text: string): string {
  const promotion = /\s*#?(欢迎关注|关注我们|本文来自|扫码|点击阅读原文|阅读原文|原文链接|微信号[:：]).*$/u
  return text
    .split('\n')
    .map((line) => line.replace(promotion, '').trim())
    .filter(Boolean)
    .join('\n')
}

function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  return match ? match[1] : undefined
}

function all(block: string, name: string): string[] {
  return [...block.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'gi'))].map((match) => match[1] ?? '')
}

function attribute(block: string, name: string, attr: string): string[] {
  return [...block.matchAll(new RegExp(`<${name}\\s[^>]*?${attr}=["']([^"']+)["'][^>]*>`, 'gi'))].map((match) => decode(match[1] ?? ''))
}

function date(text: string | undefined): number | undefined {
  if (!text) return undefined
  const at = Date.parse(plain(text))
  return Number.isNaN(at) ? undefined : at
}

export function parseFeed(xml: string): FeedItem[] {
  const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml)
  const blocks = atom ? all(xml, 'entry') : all(xml, 'item')
  const items: FeedItem[] = []
  for (const block of blocks) {
    const title = plain(tag(block, 'title') ?? '')
    if (!title) continue
    const link = atom
      ? (attribute(block, 'link', 'href')[0] ?? undefined)
      : (plain(tag(block, 'link') ?? '') || undefined)
    const id = plain(tag(block, atom ? 'id' : 'guid') ?? '') || link || title
    const summary = plain(
      tag(block, 'description') ?? tag(block, 'summary') ?? tag(block, 'content:encoded') ?? tag(block, 'content') ?? '',
    )
    const at = date(tag(block, atom ? 'updated' : 'pubDate') ?? tag(block, 'published') ?? tag(block, 'dc:date'))
    const tags = atom ? attribute(block, 'category', 'term') : all(block, 'category').map(plain)
    items.push({ id, title, ...(link ? { link } : {}), summary, ...(at !== undefined ? { at } : {}), tags: tags.filter(Boolean) })
  }
  return items
}
