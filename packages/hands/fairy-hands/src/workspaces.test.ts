import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import * as hands from './index.js'
import { slugFor } from './workspaces.js'

function room() {
  const root = mkdtempSync(join(tmpdir(), 'fairy-ws-'))
  return { root, max: 2 }
}

async function host(workspace: { root: string; max: number }) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {}).await()
  await ctx.plugin(ToolRuntime, {}).await()
  await ctx.plugin(hands, { workspace }).await()
  return ctx
}

function call(ctx: Context, name: string, args: Record<string, unknown>) {
  return ctx.tools.execute({
    callId: `call-${name}` as ToolExecutionInput['callId'],
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
}

test('a room gets a folder, a README she owns, and a name the filesystem can hold', async () => {
  const workspace = room()
  const ctx = await host(workspace)
  const created = await call(ctx, 'workspace_new', { name: '博客改版', why: '把首页换成新的样子' })
  assert.equal(created.isError, false)

  // Chinese has no ASCII form without a transliteration table; the slug is still legible.
  const folder = join(workspace.root, 'ws-1')
  assert.ok(existsSync(folder), 'the room exists on disk')
  const readme = readFileSync(join(folder, 'README.md'), 'utf8')
  assert.match(readme, /^# 博客改版/u)
  assert.match(readme, /把首页换成新的样子/u)

  const listed = await call(ctx, 'workspace_list', {})
  assert.match(String(listed.value), /博客改版/u)
  assert.match(String(listed.value), /1\/2/)
})

test('an ASCII name keeps its own slug, and duplicates get a suffix', () => {
  assert.equal(slugFor('blog-rework', []), 'blog-rework')
  assert.equal(slugFor('Blog Rework!', []), 'blog-rework')
  assert.equal(slugFor('blog-rework', ['blog-rework']), 'blog-rework-2')
  assert.equal(slugFor('博客', []), 'ws-1')
})

test('the cap holds: with two rooms open, a third is refused until one is archived', async () => {
  const workspace = room()
  const ctx = await host(workspace)
  await call(ctx, 'workspace_new', { name: 'one', why: 'x' })
  await call(ctx, 'workspace_new', { name: 'two', why: 'y' })
  const third = await call(ctx, 'workspace_new', { name: 'three', why: 'z' })
  assert.equal(third.isError, true)
  assert.match(JSON.stringify(third), /上限 2/u)

  const archived = await call(ctx, 'workspace_archive', { slug: 'one' })
  assert.equal(archived.isError, false)
  assert.ok(existsSync(join(workspace.root, '.archive', 'one')), 'nothing is deleted, only moved aside')

  const again = await call(ctx, 'workspace_new', { name: 'three', why: 'z' })
  assert.equal(again.isError, false)
})

test('archiving something that is not there says so instead of doing nothing', async () => {
  const workspace = room()
  const ctx = await host(workspace)
  const missing = await call(ctx, 'workspace_archive', { slug: 'nope' })
  assert.equal(missing.isError, true)
  assert.match(JSON.stringify(missing), /没有叫 nope/u)
})
