import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import * as hands from './index.js'

const blog = { url: 'https://lycoreco.cn/', user: 'owner', password: 'abcd efgh ijkl mnop qrst uvwx' }

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

test('a post is a draft unless the owner says publish, and the key travels as an application password', async (t) => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    // WordPress echoes what it stored, so the fake echoes the request's status like the real API.
    const asked = JSON.parse(String(init.body)) as { status: string }
    return new Response(JSON.stringify({ id: 42, link: 'https://lycoreco.cn/?p=42', status: asked.status }), { status: 201 })
  })
  const ctx = await host({ blog })

  const result = await call(ctx, { title: '搬家', content: '<p>她搬到服务器上了</p>', status: 'publish', tags: 'fairy, 部署' })
  assert.equal(result.isError, false)
  assert.match(String(result.value), /已发布（id 42）：https:\/\/lycoreco\.cn\/\?p=42/u)

  const [call1] = calls
  assert.equal(call1?.url, 'https://lycoreco.cn/wp-json/wp/v2/posts')
  assert.equal(new URL(call1!.url).pathname, '/wp-json/wp/v2/posts', 'the trailing slash on the site root does not double up')
  const headers = call1!.init.headers as Record<string, string>
  // The password's spaces are presentation; the header must carry them removed.
  assert.equal(headers.authorization, `Basic ${Buffer.from('owner:abcdefghijklmnopqrstuvwx').toString('base64')}`)
  const body = JSON.parse(String(call1!.init.body))
  assert.deepEqual(body, { title: '搬家', content: '<p>她搬到服务器上了</p>', status: 'publish', tags: ['fairy', '部署'] })

  const draft = await call(ctx, { title: '草稿', content: 'x' })
  assert.match(String(draft.value), /已存为草稿/)
  assert.equal(JSON.parse(String(calls[1]!.init.body)).status, 'draft')
})

test('when WordPress refuses, the reason comes back instead of a silent failure', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{"code":"rest_cannot_create"}', { status: 401 }))
  const ctx = await host({ blog })
  const result = await call(ctx, { title: 'x', content: 'y' })
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result), /WordPress refused the post \(401\)/)
  assert.match(JSON.stringify(result), /rest_cannot_create/)
})

test('a deployment with no blog gets no blog tool at all', async () => {
  const ctx = await host({})
  const result = await call(ctx, { title: 'x', content: 'y' })
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result), /blog_publish/)
})
