import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { renderContextSnapshot, renderPrompt, SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { FairySelf, type FairyFact, type FairyIdentity, type FairyStatus } from './index.js'
import * as presence from './presence.js'

class StubSelf extends FairySelf {
  identity(): FairyIdentity {
    // `{{...}}` in her own words must reach the model literally, not as a prompt template.
    return { name: 'Fairy', voice: '说话带{{刺}}', origin: '在测试里醒来' }
  }
  status(): FairyStatus {
    return { at: 0, asleep: false, doing: '读书', mood: 0.3, energy: 0.6, drives: { curiosity: 0.4 } }
  }
  facts(): FairyFact[] {
    return [{ id: 'state:mood', text: '你现在心情不错' }]
  }
}

async function host() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {}).await()
  await ctx.plugin(ToolRuntime, {}).await()
  await ctx.plugin(StubSelf).await()
  const fiber = ctx.plugin(presence, { identityOrder: 50, contextOrder: 300 })
  await fiber.await()
  return { ctx, fiber }
}

test('her identity is in the system prompt and her state in dynamic context', async () => {
  const { ctx } = await host()
  const assembly = await ctx.systemPrompt.assemble()
  const prompt = renderPrompt(assembly)
  assert.match(prompt, /你叫Fairy。/)
  assert.ok(prompt.includes('说话带{{刺}}'))
  // State changes every turn, so it stays out of the cached system prompt.
  assert.doesNotMatch(prompt, /你现在心情不错/)
  assert.match(renderContextSnapshot(assembly), /\[state:mood\] 你现在心情不错/)
})

test('fairy_status runs through the real tool pipeline', async () => {
  const { ctx } = await host()
  const assembly = await ctx.systemPrompt.assemble()
  assert.ok(assembly.tools.some((tool) => tool.name === 'fairy_status'))
  const result = await ctx.tools.execute({
    callId: 'call-1' as ToolExecutionInput['callId'],
    name: 'fairy_status',
    arguments: {},
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, false)
  assert.match(String(result.value), /醒着，正在读书/)
})

test('unloading her presence takes everything it registered with it', async () => {
  const { ctx, fiber } = await host()
  await fiber.dispose()
  const assembly = await ctx.systemPrompt.assemble()
  assert.doesNotMatch(renderPrompt(assembly), /你叫Fairy/)
  assert.equal(renderContextSnapshot(assembly), '')
  assert.ok(!assembly.tools.some((tool) => tool.name === 'fairy_status'))
})
