import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { SessionId } from '@deepseek-ai/dsh-session'
import { encode, parseHost, PROTOCOL_VERSION, type HostMessage } from '@fairy/protocol'
import {
  FairySelf,
  type FairyFact,
  type FairyHeard,
  type FairyIdentity,
  type FairyLine,
  type FairyMemory,
  type FairyNote,
  type FairyPerception,
  type FairyPerson,
  type FairyShelfItem,
  type FairySpeech,
  type FairyStatus,
  type FairyUrge,
} from '@fairy/core'
import { connect, FairyLink, type SessionSender } from './index.js'

const dir = mkdtempSync(join(tmpdir(), 'fairy-link-'))
const fibers: Array<{ dispose(): Promise<void> }> = []
after(async () => {
  for (const fiber of fibers) await fiber.dispose()
  rmSync(dir, { recursive: true, force: true })
})

class StubSelf extends FairySelf {
  conversationWhere: string | undefined = 'dsh-session:s-old'
  identity(): FairyIdentity {
    return { name: 'Fairy', voice: '冷静', origin: '测试' }
  }
  status(): FairyStatus {
    return { at: 1000, asleep: false, doing: '看书', mood: 0.2, energy: 0.7, drives: { curiosity: 0.4 }, bonds: { owner: 'familiar' } }
  }
  facts(): FairyFact[] {
    return []
  }
  async hear(person: FairyPerson, text: string): Promise<FairyHeard> {
    void person
    void text
    return { id: 'e1' }
  }
  async perceive(perception: FairyPerception): Promise<void> {
    void perception
  }
  async speak(speech: FairySpeech): Promise<void> {
    void speech
  }
  async remember(query: string): Promise<FairyMemory[]> {
    return [{ id: 'e9', at: 5, clarity: 'clear', text: `关于${query}：主人对花生过敏` }]
  }
  async note(note: FairyNote): Promise<void> {
    void note
  }
  async stock(item: FairyShelfItem): Promise<boolean> {
    void item
    return true
  }
  async speakUp(urge: FairyUrge, text: string): Promise<void> {
    void urge
    void text
  }
  lastConversation(): string | undefined {
    return this.conversationWhere
  }
  conversation(): FairyLine[] {
    return [
      { id: 'e100', at: 900, who: 'owner', text: '在吗' },
      { id: 'e101', at: 1000, who: 'fairy', text: '在。' },
    ]
  }
}

class FakeSender implements SessionSender {
  readonly created: Array<{ cwd?: string; agentPreset?: string }> = []
  readonly prompted: Array<{ sessionId: string; text: string; image?: string }> = []
  /** Conversations this host actually has; anything else fails like a missing session does. */
  readonly existing = new Set(['s-old', 's-new'])
  async create(request: { cwd?: string; agentPreset?: string }): Promise<{ sessionId: SessionId }> {
    this.created.push(request)
    return { sessionId: SessionId('s-new') }
  }
  async prompt(request: {
    sessionId: SessionId
    content: ReadonlyArray<{ type: 'text'; text: string } | { type: 'image'; mediaType: string; data: string; name?: string }>
  }): Promise<{ accepted: true }> {
    if (!this.existing.has(String(request.sessionId))) throw new Error(`session/not-found ${String(request.sessionId)}`)
    const text = request.content.find((part) => part.type === 'text')
    const image = request.content.find((part) => part.type === 'image')
    this.prompted.push({
      sessionId: String(request.sessionId),
      text: text && text.type === 'text' ? text.text : '',
      ...(image && image.type === 'image' ? { image: image.mediaType } : {}),
    })
    return { accepted: true }
  }
  async list(): Promise<{ items: Array<{ sessionId: SessionId; updatedAt: number }> }> {
    return { items: [{ sessionId: SessionId('s-old'), updatedAt: 42 }] }
  }
}

async function host(options: { conversation?: string | undefined } = {}, link: Partial<Record<string, unknown>> = {}) {
  const ctx = new Context()
  await ctx.plugin(StubSelf).await()
  const self = ctx.fairySelf as StubSelf
  if ('conversation' in options) self.conversationWhere = options.conversation
  const web = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await web.await()
  fibers.push(web)
  const sender = new FakeSender()
  ctx.provide('sessionController', sender)
  const fiber = ctx.plugin(FairyLink, {
    devicesPath: join(dir, `devices-${Math.random().toString(16).slice(2)}.json`),
    sessionCwd: dir,
    agentPreset: 'fairy',
    ownerId: 'owner',
    ownerName: '主人',
    confirmTimeoutMs: 2000,
    pairCodeMinutes: 5,
    pairLockoutFailures: 20,
    pairLockoutMinutes: 15,
    ...link,
  })
  await fiber.await()
  fibers.push(fiber)
  return { ctx, fiber, self, sender, base: `http://127.0.0.1:${ctx.webServer.port}` }
}

async function until(done: () => boolean, what = 'the frame'): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function pair(base: string, code: string, name = '主人的手机', kind = 'app'): Promise<{ token: string; device: { id: string } }> {
  const response = await fetch(`${base}/fairy/link/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ code, name, kind }),
  })
  return (await response.json()) as { token: string; device: { id: string } }
}

/** One connected test device, collecting every frame the host sends it. */
async function device(base: string, token: string, accepts: string[] = ['push', 'confirm']) {
  const peer = await connect(`${base.replace('http', 'ws')}/fairy/link/v1`)
  const inbox: HostMessage[] = []
  peer.onMessage((raw) => {
    const parsed = parseHost(raw)
    if (parsed.ok) inbox.push(parsed.message)
    else throw new Error(parsed.reason)
  })
  peer.send(encode({ type: 'hello', id: 'h1', protocol: PROTOCOL_VERSION, token, device: { name: '测试机', kind: 'cli' }, accepts: accepts as never }))
  await until(() => inbox.some((message) => message.type === 'welcome'), 'the welcome')
  return { peer, inbox }
}

test('the live code is left where the owner can read it, and a new one replaces it', async () => {
  const { ctx, base } = await host()
  const file = join(dir, 'pairing-code')
  const [code, expires] = readFileSync(file, 'utf8').trim().split(/\s+/u)
  assert.equal(code, ctx.fairyLink.pairingCode()!.code)
  assert.ok(Number(expires) > Date.now(), 'the file says when it dies')

  const rotated = ctx.fairyLink.rotate()
  assert.notEqual(rotated.code, code)
  assert.equal(readFileSync(file, 'utf8').trim().split(/\s+/u)[0], rotated.code)

  // Pairing spends the code and immediately hands out the next one.
  const { token } = await pair(base, rotated.code)
  assert.ok(token)
  assert.notEqual(ctx.fairyLink.pairingCode()?.code, rotated.code)
})

test('a fixed code is kept, not spent, and pairing twice needs no new one', async () => {
  const { ctx, base } = await host({}, { pairCode: 'fairy-owner-2026' })
  const file = join(dir, 'pairing-code')
  assert.equal(readFileSync(file, 'utf8').trim(), 'fairy-owner-2026 0', 'expiry 0 means "does not change"')
  const first = await pair(base, 'fairy-owner-2026', '手机')
  const second = await pair(base, 'fairy-owner-2026', '平板')
  assert.ok(first.token && second.token)
  assert.equal(ctx.fairyLink.pairingCode()?.code, 'fairy-owner-2026')
  assert.equal(ctx.fairyLink.pairingCode()?.expiresAt, 0, 'a fixed code never expires')
})

test('a short fixed code is refused at startup, because it would be guessable forever', async () => {
  await assert.rejects(host({}, { pairCode: '123456' }), /at least 12 characters/)
})

test('repeated wrong codes from anywhere pause pairing, even for the right code', async () => {
  const { ctx, base } = await host({}, { pairCode: 'fairy-owner-2026', pairLockoutFailures: 2, pairLockoutMinutes: 1 })
  const wrong = await fetch(`${base}/fairy/link/pair`, { method: 'POST', body: JSON.stringify({ code: 'nope', name: 'x' }) })
  assert.equal(wrong.status, 403)
  const wrongAgain = await fetch(`${base}/fairy/link/pair`, { method: 'POST', body: JSON.stringify({ code: 'nope2', name: 'x' }) })
  assert.equal(wrongAgain.status, 403)
  const paused = await fetch(`${base}/fairy/link/pair`, { method: 'POST', body: JSON.stringify({ code: 'fairy-owner-2026', name: 'x' }) })
  assert.equal(paused.status, 429, 'the lockout applies before the code is even looked at')
  assert.equal(ctx.fairyLink.devices().length, 0)
})

test('a screen that just opened can ask what was said before', async () => {
  const { ctx, base } = await host()
  const { token } = await pair(base, ctx.fairyLink.pairingCode()!.code)
  const { peer, inbox } = await device(base, token)
  peer.send(encode({ type: 'history', id: 'h1', limit: 20 }))
  await until(() => inbox.some((message) => message.type === 'history'), 'the history')
  const history = inbox.find((message) => message.type === 'history')!
  assert.deepEqual(
    history.lines.map((line) => [line.who, line.text]),
    [
      ['owner', '在吗'],
      ['fairy', '在。'],
    ],
  )
  peer.close()
})

test('a picture travels with the words and arrives as an image part', async () => {
  const { ctx, base, sender } = await host()
  const { token } = await pair(base, ctx.fairyLink.pairingCode()!.code)
  const { peer } = await device(base, token)
  const data = Buffer.from('not-really-a-png').toString('base64')
  peer.send(encode({ type: 'say', id: 's1', text: '看这个', images: [{ mediaType: 'image/png', data, name: 'a.png' }] }))
  await until(() => sender.prompted.length === 1, 'the prompt')
  assert.equal(sender.prompted[0]?.text, '看这个')
  assert.equal(sender.prompted[0]?.image, 'image/png')
  peer.close()
})

test('a picture on its own is a message too', async () => {
  const { ctx, base, sender } = await host()
  const { token } = await pair(base, ctx.fairyLink.pairingCode()!.code)
  const { peer } = await device(base, token)
  const data = Buffer.from('x').toString('base64')
  peer.send(encode({ type: 'say', id: 's2', text: '', images: [{ mediaType: 'image/jpeg', data }] }))
  await until(() => sender.prompted.length === 1, 'the prompt')
  assert.equal(sender.prompted[0]?.image, 'image/jpeg')
  peer.close()
})

test('a pairing code buys exactly one token, and only the right code buys any', async () => {
  const { ctx, base } = await host()
  const code = ctx.fairyLink.pairingCode()!.code

  const wrong = await fetch(`${base}/fairy/link/pair`, { method: 'POST', body: JSON.stringify({ code: 'nope', name: 'x' }) })
  assert.equal(wrong.status, 403)

  const paired = await pair(base, code)
  assert.ok(paired.token.length > 20)
  assert.ok(ctx.fairyLink.devices().some((device) => device.id === paired.device.id))

  // The same code cannot pair a second device.
  const again = await fetch(`${base}/fairy/link/pair`, { method: 'POST', body: JSON.stringify({ code, name: 'y' }) })
  assert.equal(again.status, 403)

  // Nor does a revoked device keep working.
  assert.equal(ctx.fairyLink.revoke(paired.device.id), true)
  assert.ok(!ctx.fairyLink.devices().some((device) => device.id === paired.device.id))
})

test('a device that says hello is greeted as one, and its words reach her last conversation', async () => {
  const { ctx, base, sender } = await host()
  const { token } = await pair(base, ctx.fairyLink.pairingCode()!.code)
  const { peer, inbox } = await device(base, token)

  const welcome = inbox.find((message) => message.type === 'welcome')
  assert.equal(welcome?.name, 'Fairy')
  assert.equal(welcome?.sessionId, 's-old', 'the conversation she last had')

  peer.send(encode({ type: 'say', id: 'say1', text: '在吗' }))
  await until(() => sender.prompted.length === 1, 'the prompt')
  assert.deepEqual(sender.prompted[0], { sessionId: 's-old', text: '在吗' })

  // What the model says in that turn comes back as her whole reply.
  const emit = ctx.emit.bind(ctx) as unknown as (name: string, ...args: unknown[]) => void
  emit('session/event', { id: 's-old' }, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '在。' }, { type: 'text', text: '说吧。' }] } },
  })
  emit('session/event', { id: 's-old' }, { type: 'turn/end', data: { turn: 3 } })
  await until(() => inbox.some((message) => message.type === 'reply.done'), 'her reply')
  const done = inbox.find((message) => message.type === 'reply.done')
  assert.equal(done?.text, '在。说吧。')
  assert.equal(done?.turn, '3')
  peer.close()
})

test('a conversation she remembers but this host does not have is replaced, not reported', async () => {
  // This is what a moved life looks like: her log points at a DSH session that stayed behind.
  const { ctx, base, sender } = await host({ conversation: 'dsh-session:s-gone' })
  const { token } = await pair(base, ctx.fairyLink.pairingCode()!.code)
  const { peer, inbox } = await device(base, token)
  peer.send(encode({ type: 'say', id: 'say3', text: '在吗' }))
  await until(() => sender.prompted.length === 1, 'the prompt')
  assert.deepEqual(sender.created, [{ cwd: dir, agentPreset: 'fairy' }], 'she gets a new conversation instead of an error')
  assert.deepEqual(sender.prompted[0], { sessionId: 's-new', text: '在吗' })
  assert.ok(!inbox.some((message) => message.type === 'error'), 'the owner never sees the failure')
  peer.close()
})

test('with no conversation to fall back on, her first words in a device start one', async () => {
  const { ctx, base, sender } = await host({ conversation: undefined })
  const { token } = await pair(base, ctx.fairyLink.pairingCode()!.code)
  const { peer } = await device(base, token)
  peer.send(encode({ type: 'say', id: 'say2', text: '你好' }))
  await until(() => sender.prompted.length === 1, 'the prompt')
  assert.deepEqual(sender.created, [{ cwd: dir, agentPreset: 'fairy' }])
  assert.deepEqual(sender.prompted[0], { sessionId: 's-new', text: '你好' })
  peer.close()
})

test('a device can ask how she is and what she remembers', async () => {
  const { ctx, base } = await host()
  const { token } = await pair(base, ctx.fairyLink.pairingCode()!.code)
  const { peer, inbox } = await device(base, token)

  peer.send(encode({ type: 'status', id: 's1' }))
  await until(() => inbox.some((message) => message.type === 'status'), 'her state')
  const status = inbox.find((message) => message.type === 'status')!
  assert.equal(status.status.doing, '看书')
  assert.equal(status.status.bond, 'familiar')

  peer.send(encode({ type: 'recall', id: 'r1', query: '花生' }))
  await until(() => inbox.some((message) => message.type === 'recall'), 'her memory')
  const recall = inbox.find((message) => message.type === 'recall')!
  assert.equal(recall.memories[0]?.text.includes('花生'), true)
  peer.close()
})

test('a confirmation waits on the device, and its answer is what comes back', async () => {
  const { ctx, base } = await host()
  const { token } = await pair(base, ctx.fairyLink.pairingCode()!.code)
  const { peer, inbox } = await device(base, token)

  const answer = ctx.fairyLink.confirm(
    {
      id: 'fairy-guard',
      header: 'Fairy 想做一件需要你点头的事',
      question: '删除或不可撤销：删除文件或文件夹。要让她做吗？',
      options: [{ label: '允许这一次' }, { label: '不允许' }],
    },
    new AbortController().signal,
  )

  await until(() => inbox.some((message) => message.type === 'confirm'), 'the confirmation')
  const confirm = inbox.find((message) => message.type === 'confirm')!
  assert.equal(confirm.options.length, 2)
  peer.send(encode({ type: 'answer', id: 'a1', confirm: confirm.id, selected: ['允许这一次'] }))
  assert.deepEqual(await answer, { selected: ['允许这一次'] })
  peer.close()
})

test('with no device to ask, a confirmation is left to the Web UI', async () => {
  const { ctx } = await host()
  const answer = await ctx.fairyLink.confirm(
    { id: 'q', question: '要吗？', options: [{ label: '要' }] },
    new AbortController().signal,
  )
  assert.equal(answer, undefined)
})

test('a device that is not paired is turned away before it can say anything', async () => {
  const { base } = await host()
  const peer = await connect(`${base}/fairy/link/v1`)
  const inbox: HostMessage[] = []
  peer.onMessage((raw) => {
    const parsed = parseHost(raw)
    if (parsed.ok) inbox.push(parsed.message)
  })
  peer.send(encode({ type: 'hello', id: 'h1', protocol: PROTOCOL_VERSION, token: 'not-a-token', device: { name: '冒名的设备', kind: 'cli' } }))
  await until(() => inbox.some((message) => message.type === 'error'), 'the refusal')
  assert.match(String((inbox.find((message) => message.type === 'error') as { message?: string }).message), /not paired/u)
  peer.close()
})
