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
  type FairyBond,
  type FairyHeard,
  type FairyIdentity,
  type FairyMemory,
  type FairyNote,
  type FairyPerson,
  type FairySpeech,
  type FairyStatus,
  type FairyUrge,
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
  bond: FairyBond = 'stranger'
  status(): FairyStatus {
    return { at: 0, asleep: false, doing: '读书', mood: 0.3, energy: 0.6, drives: { curiosity: 0.4 }, bonds: { owner: this.bond } }
  }
  facts(options: { personId?: string; cue?: string } = {}): FairyFact[] {
    const facts = [{ id: 'state:mood', text: '你现在心情不错' }]
    if (options.cue?.includes('花生')) facts.push({ id: 'e9', text: '你想起：主人对你说：我对花生过敏' })
    return facts
  }
  readonly where: Array<string | undefined> = []
  readonly urged: Array<{ urge: FairyUrge; text: string }> = []
  async perceive(): Promise<void> {}
  async stock(): Promise<boolean> {
    return true
  }
  async speakUp(urge: FairyUrge, text: string): Promise<void> {
    this.urged.push({ urge, text })
  }
  async hear(person: FairyPerson, text: string, where?: string): Promise<FairyHeard> {
    this.heard.push({ person, text })
    this.where.push(where)
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
  /** Where her last conversation was kept; the tests set it as if she had talked before. */
  conversation: string | undefined
  lastConversation(): string | undefined {
    return this.conversation
  }
}

/** Stand-in for the Web app's session controller: reopens one closed conversation on demand. */
class StubOpener {
  readonly asked: string[] = []
  constructor(private readonly answer: { agent: Agent; followups: UserMessage[] } | { error: unknown }) {}
  async resolveAgent(sessionId: unknown): Promise<{ agent: Agent } | { error: unknown }> {
    this.asked.push(String(sessionId))
    return 'agent' in this.answer ? { agent: this.answer.agent } : this.answer
  }
}

async function host(opener?: StubOpener) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {}).await()
  await ctx.plugin(ToolRuntime, {}).await()
  await ctx.plugin(StubSelf).await()
  if (opener) ctx.provide('sessionController', opener)
  const fiber = ctx.plugin(presence, {
    identityOrder: 50,
    contextOrder: 300,
    ownerId: 'owner',
    ownerName: '主人',
    maxRecordedChars: 40,
    chatStyle: '像发消息一样说话。',
    bondTones: { stranger: '还不熟。', familiar: '已经熟了。' },
  })
  await fiber.await()
  return { ctx, fiber, self: ctx.fairySelf as StubSelf }
}

/** Just enough of an agent and its session for what presence reads. */
function agent(id = 's-1') {
  const session = { id } as unknown as Session
  const followups: UserMessage[] = []
  return { session, followups, agent: { session, followup: (message: UserMessage) => followups.push(message) } as unknown as Agent }
}

/** Waits for something another fiber does, without fixing how many ticks it takes. */
async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('timed out waiting')
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
  assert.match(prompt, /# 聊天的样子\n像发消息一样说话。/)
  // State changes every turn, so it stays out of the cached system prompt.
  assert.doesNotMatch(prompt, /你现在心情不错/)
  assert.match(renderContextSnapshot(assembly), /\[state:mood\] 你现在心情不错/)
})

test('her tone follows how well she knows the owner, in the context of each request', async () => {
  const { ctx, self } = await host()
  const before = renderContextSnapshot(await ctx.systemPrompt.assemble())
  assert.match(before, /# 你和主人现在的关系\n还不熟。/)
  self.bond = 'familiar'
  const after = renderContextSnapshot(await ctx.systemPrompt.assemble())
  assert.match(after, /# 你和主人现在的关系\n已经熟了。/)
  // The cached system prompt does not change with it.
  assert.doesNotMatch(renderPrompt(await ctx.systemPrompt.assemble()), /已经熟了/)
})

test('a turn enters her life: heard before the model is asked, answered when it ends', async () => {
  const { ctx, self } = await host()
  const target = agent()
  const decision = await preStep(ctx, target, [message('零食里有花生吗')])
  assert.equal(decision.kind, 'enter')
  assert.deepEqual(self.heard, [{ person: { personId: 'owner', name: '主人' }, text: '零食里有花生吗' }])
  // Her memory of it points at the session that has the rest.
  assert.deepEqual(self.where, ['dsh-session:s-1'])

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

test('an urge of hers becomes a turn she starts in the last conversation, and her words are kept', async () => {
  const { ctx, self } = await host()
  const target = agent()
  // Nowhere to say it yet: nothing happens.
  const urge = { id: 'e50', at: 0, personId: 'owner', name: '主人', why: 'share' as const, about: '一篇讲芯片的文章' }
  ctx.emit('fairy/urge', urge)
  assert.equal(target.followups.length, 0)

  await preStep(ctx, target, [message('在吗')])
  emit(ctx, target, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()
  ctx.emit('fairy/urge', urge)
  assert.equal(target.followups.length, 1)
  const turn = target.followups[0]!
  assert.deepEqual(turn.source, { kind: 'fairy-urge', urge: 'e50' })
  assert.match(JSON.stringify(turn.content), /不是主人发来的消息/)

  // The harness runs it: not heard as something the owner said, and her words go to speakUp.
  const heardBefore = self.heard.length
  await preStep(ctx, target, [turn])
  assert.equal(self.heard.length, heardBefore)
  reply(ctx, target, '主人，刚看到一篇芯片的文章，你应该会感兴趣。')
  emit(ctx, target, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle()
  assert.deepEqual(self.urged.map((item) => [item.urge.id, item.text]), [['e50', '主人，刚看到一篇芯片的文章，你应该会感兴趣。']])
})

test('an urge she decides not to act on is not recorded as said', async () => {
  const { ctx, self } = await host()
  const target = agent()
  await preStep(ctx, target, [message('在吗')])
  emit(ctx, target, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  ctx.emit('fairy/urge', { id: 'e60', at: 0, personId: 'owner', why: 'missed', about: '好久没说话了' })
  await preStep(ctx, target, [target.followups[0]!])
  reply(ctx, target, '…')
  emit(ctx, target, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle()
  assert.equal(self.urged.length, 0)
})

test('with no window open, her words reopen the conversation the owner last used', async () => {
  const reopened = agent('s-cold')
  const opener = new StubOpener({ agent: reopened.agent, followups: reopened.followups })
  const { ctx, self } = await host(opener)
  self.conversation = 'dsh-session:s-cold'

  const urge = { id: 'e70', at: 0, personId: 'owner', name: '主人', why: 'missed' as const, about: '两天没听他说话了' }
  ctx.emit('fairy/urge', urge)
  await until(() => reopened.followups.length > 0)
  assert.deepEqual(opener.asked, ['s-cold'])
  const turn = reopened.followups[0]!
  assert.deepEqual(turn.source, { kind: 'fairy-urge', urge: 'e70' })

  // The harness runs that turn: she is not answering anything the owner said, and her words are kept.
  await preStep(ctx, reopened, [turn])
  assert.equal(self.heard.length, 0)
  reply(ctx, reopened, '主人，两天没动静了，你在忙什么。')
  emit(ctx, reopened, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()
  assert.deepEqual(
    self.urged.map((item) => [item.urge.id, item.text]),
    [['e70', '主人，两天没动静了，你在忙什么。']],
  )
})

test('with no conversation to reopen, that urge waits instead of pretending or crashing', async () => {
  const opener = new StubOpener({ error: new Error('no such session') })
  const { ctx, self } = await host(opener)
  const urge = { id: 'e80', at: 0, personId: 'owner', why: 'share' as const, about: '一篇讲芯片的文章' }

  // She has never had a conversation: there is nowhere to put it, and nothing is asked of the host.
  ctx.emit('fairy/urge', urge)
  await settle()
  assert.deepEqual(opener.asked, [])

  // One exists but is gone from the host: still nothing lands, and nothing throws.
  self.conversation = 'dsh-session:s-gone'
  ctx.emit('fairy/urge', urge)
  await until(() => opener.asked.length > 0)
  assert.deepEqual(opener.asked, ['s-gone'])
  assert.equal(self.urged.length, 0)
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
