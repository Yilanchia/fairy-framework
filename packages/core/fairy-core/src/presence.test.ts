import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { renderContextSnapshot, renderPrompt, SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import {
  FairySelf,
  type FairyFact,
  type FairyHeard,
  type FairyIdentity,
  type FairyMemory,
  type FairyNote,
  type FairyPerson,
  type FairySpeech,
  type FairyStatus,
} from './index.js'
import * as presence from './presence.js'

const CRISIS = '我在听。请现在就联系一个你信任的人。'

/** A self that records what it is told, so the tests can see what reached her life. */
class StubSelf extends FairySelf {
  readonly heard: Array<{ person: FairyPerson; text: string }> = []
  readonly spoken: FairySpeech[] = []
  readonly searched: string[] = []
  identity(): FairyIdentity {
    // `{{...}}` in her own words must reach the model literally, not as a prompt template.
    return { name: 'Fairy', voice: '说话带{{刺}}', origin: '在测试里醒来' }
  }
  status(): FairyStatus {
    return { at: 0, asleep: false, doing: '读书', mood: 0.3, energy: 0.6, drives: { curiosity: 0.4 } }
  }
  facts(options: { personId?: string; cue?: string } = {}): FairyFact[] {
    const facts = [{ id: 'state:mood', text: '你现在心情不错' }]
    if (options.cue?.includes('花生')) facts.push({ id: 'e9', text: '你想起：主人对你说：我对花生过敏' })
    return facts
  }
  async hear(person: FairyPerson, text: string): Promise<FairyHeard> {
    this.heard.push({ person, text })
    return { id: `e${100 + this.heard.length}`, ...(text.includes('不想活') ? { urgent: CRISIS } : {}) }
  }
  async speak(speech: FairySpeech): Promise<void> {
    this.spoken.push(speech)
  }
  readonly notes: FairyNote[] = []
  async note(note: FairyNote): Promise<void> {
    this.notes.push(note)
  }
  async remember(query: string): Promise<FairyMemory[]> {
    this.searched.push(query)
    return [{ id: 'e9', at: 0, clarity: 'clear', text: '11月2日 10:30 主人对你说：我对花生过敏' }]
  }
}

async function host() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {}).await()
  await ctx.plugin(ToolRuntime, {}).await()
  await ctx.plugin(StubSelf).await()
  const fiber = ctx.plugin(presence, {
    identityOrder: 50,
    contextOrder: 300,
    ownerId: 'owner',
    ownerName: '主人',
    maxRecordedChars: 40,
  })
  await fiber.await()
  return { ctx, fiber, self: ctx.fairySelf as StubSelf }
}

/** Just enough of an agent and its session for what presence reads. */
function agent() {
  const session = {} as Session
  return { session, agent: { session } as unknown as Agent }
}

function message(text: string, kind = 'user'): UserMessage {
  return { id: `m-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind } } as unknown as UserMessage
}

/** What DeepSeek Harness does before a step: offer the claimed messages through the waterfall. */
async function preStep(ctx: Context, target: ReturnType<typeof agent>, messages: UserMessage[]) {
  return ctx.waterfall(
    'agent/pre-step',
    { agent: target.agent, messages, turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter' as const, messages }),
  )
}

function emit(ctx: Context, target: ReturnType<typeof agent>, type: string, data: unknown) {
  ctx.emit('session/event', target.session, { type, seq: 0, time: 0, data } as unknown as SessionEvent)
}

function reply(ctx: Context, target: ReturnType<typeof agent>, text: string) {
  emit(ctx, target, 'assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4' } },
  })
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

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

test('a turn enters her life: heard before the model is asked, answered when it ends', async () => {
  const { ctx, self } = await host()
  const target = agent()
  const decision = await preStep(ctx, target, [message('零食里有花生吗')])
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(self.heard, [{ person: { personId: 'owner', name: '主人' }, text: '零食里有花生吗' }])

  // What the message brought to mind is in the context of this very request.
  const assembly = await ctx.systemPrompt.assemble({ agent: target.agent })
  assert.match(renderContextSnapshot(assembly), /\[e9\] 你想起：主人对你说：我对花生过敏/)

  reply(ctx, target, '有，别吃。')
  reply(ctx, target, '我已经从购物车里删掉了。这一句很长很长很长很长很长很长很长很长很长')
  emit(ctx, target, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()
  assert.equal(self.spoken.length, 1)
  const [spoken] = self.spoken
  assert.equal(spoken?.inReplyTo, 'e101')
  assert.equal(spoken?.speaker, 'dsh:deepseek-v4')
  assert.ok(spoken?.text.startsWith('有，别吃。\n\n我已经从购物车里删掉了。'))
  assert.ok(spoken!.text.length <= 41, 'a long reply is kept to its start')
})

test('only what a person typed is heard, and a turn that said nothing records nothing', async () => {
  const { ctx, self } = await host()
  const target = agent()
  await preStep(ctx, target, [message('<file changed>', 'file-change')])
  assert.equal(self.heard.length, 0)

  await preStep(ctx, target, [message('在吗')])
  emit(ctx, target, 'turn/end', { turn: 1, reason: { kind: 'error' } })
  await settle()
  assert.equal(self.heard.length, 1)
  assert.equal(self.spoken.length, 0)
})

test('someone in danger gets the fixed reply first, in the context of that turn only', async () => {
  const { ctx } = await host()
  const target = agent()
  await preStep(ctx, target, [message('我不想活了')])
  const during = renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target.agent }))
  assert.ok(during.includes(CRISIS))
  emit(ctx, target, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await preStep(ctx, target, [message('谢谢你')])
  const after = renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: target.agent }))
  assert.ok(!after.includes(CRISIS))
})

test('fairy_status and fairy_recall run through the real tool pipeline', async () => {
  const { ctx, self } = await host()
  const assembly = await ctx.systemPrompt.assemble()
  assert.ok(assembly.tools.some((tool) => tool.name === 'fairy_status'))
  assert.ok(assembly.tools.some((tool) => tool.name === 'fairy_recall'))
  const call = (name: string, args: Record<string, unknown>) =>
    ctx.tools.execute({
      callId: `call-${name}` as ToolExecutionInput['callId'],
      name,
      arguments: args,
      signal: new AbortController().signal,
    })
  const status = await call('fairy_status', {})
  assert.equal(status.isError, false)
  assert.match(String(status.value), /醒着，正在读书/)
  const recall = await call('fairy_recall', { query: '花生' })
  assert.equal(recall.isError, false)
  assert.deepEqual(self.searched, ['花生'])
  assert.match(String(recall.value), /\[e9\]（清楚）11月2日 10:30 主人对你说：我对花生过敏/)
})

test('fairy_note keeps what the owner said in this turn, and nothing else', async () => {
  const { ctx, self } = await host()
  const target = agent()
  const note = (args: Record<string, unknown>) =>
    ctx.tools.execute({
      callId: 'call-note' as ToolExecutionInput['callId'],
      name: 'fairy_note',
      arguments: args,
      agent: target.agent,
      signal: new AbortController().signal,
    })
  // No message from the owner yet: there is nothing it could rest on.
  assert.equal((await note({ topic: '饮食禁忌', text: '主人对花生过敏' })).isError, true)

  await preStep(ctx, target, [message('我对花生过敏')])
  const kept = await note({ topic: '饮食禁忌', text: '主人对花生过敏，不能吃含花生的东西' })
  assert.equal(kept.isError, false)
  assert.deepEqual(self.notes, [
    { personId: 'owner', name: '主人', topic: '饮食禁忌', text: '主人对花生过敏，不能吃含花生的东西', source: 'e101' },
  ])
  const pending = await note({ topic: '护照', text: '提醒主人续护照', pending: true })
  assert.equal(pending.isError, false)
  assert.equal((self.notes as FairyNote[])[1]?.pending, true)
})

test('unloading her presence takes everything it registered with it', async () => {
  const { ctx, fiber, self } = await host()
  await fiber.dispose()
  const assembly = await ctx.systemPrompt.assemble()
  assert.doesNotMatch(renderPrompt(assembly), /你叫Fairy/)
  assert.equal(renderContextSnapshot(assembly), '')
  assert.ok(!assembly.tools.some((tool) => tool.name.startsWith('fairy_')))
  await preStep(ctx, agent(), [message('还在吗')])
  assert.equal(self.heard.length, 0)
})
