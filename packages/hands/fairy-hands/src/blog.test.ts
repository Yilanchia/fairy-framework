import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import * as hands from './index.js'

const blog = { url: 'https://lycoreco.cn/', user: 'Inoue Takina', password: 'abcd efgh ijkl mnop qrst uvwx' }

async function host(config: { blog?: typeof blog }) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {}).await()
  await ctx.plugin(ToolRuntime, {}).await()
  await ctx.plugin(hands, config).await()
  return ctx
}

function call(ctx: Context, args: Record<string, unknown>) {
  return ctx.tools.execute({
    callId: 'call-blog' as ToolExecutionInput['callId'],
    name: 'blog_publish',
    arguments: args,
    signal: new AbortController().signal,
  })
}

test('a post is a draft unless the owner says publish, and it goes over XML-RPC', async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response('<?xml version="1.0"?><methodResponse><params><param><value><int>42</int></value></param></params></methodResponse>', {
      status: 200,
    })
  })
  const ctx = await host({ blog })

  const result = await call(ctx, { title: '搬家', content: '<p>她搬到服务器上了</p>', status: 'publish' })
  assert.equal(result.isError, false)
  assert.match(String(result.value), /已发布（id 42）：https:\/\/lycoreco\.cn\/\?p=42/u)

  const [first] = calls
  assert.equal(first?.url, 'https://lycoreco.cn/xmlrpc.php', 'the blog is reached through its XML-RPC endpoint, not the REST API')
  assert.match(String(first!.init.headers && (first!.init.headers as Record<string, string>)['content-type']), /text\/xml/u)
  const body = String(first!.init.body)
  assert.match(body, /<methodName>wp.newPost<\/methodName>/u)
  assert.match(body, /<string>Inoue Takina<\/string>/u, 'the login name, spaces and all')
  assert.match(body, /<string>abcdefghijklmnopqrstuvwx<\/string>/u, 'the application password loses its presentation spaces')
  assert.match(body, /<name>post_status<\/name><value><string>publish<\/string>/u)

  const draft = await call(ctx, { title: '草稿', content: 'x' })
  assert.match(String(draft.value), /已存为草稿/u)
  assert.match(String(calls[1]!.init.body), /<name>post_status<\/name><value><string>draft<\/string>/u)
})

test('what she types cannot break the XML, and the reason for a refusal is passed on', async (t) => {
  const calls: string[] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    calls.push(String(init.body))
    return new Response(
      '<?xml version="1.0"?><methodResponse><fault><value><struct><member><name>faultString</name><value><string>用户名或密码不正确。</string></value></member></struct></value></fault></methodResponse>',
      { status: 200 },
    )
  })
  const ctx = await host({ blog })
  const result = await call(ctx, { title: 'a & b <c>', content: 'x < y && z' })
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result), /WordPress refused the post/)
  assert.match(JSON.stringify(result), /用户名或密码不正确/)
  // Escaped, not raw: one bare & or < would make the whole request unparseable.
  assert.match(calls[0]!, /<string>a &amp; b &lt;c&gt;<\/string>/u)
  assert.match(calls[0]!, /x &lt; y &amp;&amp; z/u)
})

test('a deployment with no blog gets no blog tool at all', async () => {
  const ctx = await host({})
  const result = await call(ctx, { title: 'x', content: 'y' })
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result), /blog_publish/)
})
