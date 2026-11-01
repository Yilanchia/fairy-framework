import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseFeed, plain } from './feed.js'

test('reads RSS 2.0 items, with CDATA, entities and categories', () => {
  const items = parseFeed(`<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
    <item><title><![CDATA[芯片 &amp; AI 的新进展]]></title><link>https://ex.com/a</link>
      <guid isPermaLink="false">a-1</guid><pubDate>Sun, 01 Nov 2026 08:00:00 GMT</pubDate>
      <category>芯片</category><category>AI</category>
      <description><![CDATA[<p>第一段。</p><p>第二段 &lt;b&gt;</p><script>evil()</script>]]></description></item>
    <item><title>无链接</title><description>正文</description></item>
  </channel></rss>`)
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    id: 'a-1',
    title: '芯片 & AI 的新进展',
    link: 'https://ex.com/a',
    summary: '第一段。\n第二段 <b>',
    at: Date.UTC(2026, 10, 1, 8),
    tags: ['芯片', 'AI'],
  })
  assert.equal(items[1]?.id, '无链接')
})

test('reads Atom entries', () => {
  const items = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title>
    <entry><id>tag:ex.com,2026:1</id><title type="html">Hello &amp; welcome</title>
      <link rel="alternate" href="https://ex.com/1"/><updated>2026-11-01T08:00:00Z</updated>
      <category term="编程"/><summary>摘要</summary></entry></feed>`)
  assert.deepEqual(items, [
    { id: 'tag:ex.com,2026:1', title: 'Hello & welcome', link: 'https://ex.com/1', summary: '摘要', at: Date.UTC(2026, 10, 1, 8), tags: ['编程'] },
  ])
})

test('plain text keeps no markup', () => {
  assert.equal(plain('a<br/>b &#x4e2d;&#25991; <i>c</i>'), 'a\nb 中文 c')
})
