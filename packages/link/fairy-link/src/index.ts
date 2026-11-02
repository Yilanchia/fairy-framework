import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import z from '@deepseek-ai/schemastery'
import type {} from '@fairy/core'
import { encode, parseClient, PROTOCOL_VERSION, type Accept, type DeviceKind, type HostMessage } from '@fairy/protocol'
import { DeviceStore, type Device } from './devices.js'
import { PairingCodes } from './pairing.js'
import { acceptUpgrade, type Peer } from './socket.js'

export { DeviceStore, type Device, type Paired } from './devices.js'
export { PairingCodes } from './pairing.js'
export { acceptKey, acceptUpgrade, connect, encodeFrame, FrameReader, OPCODE, type Peer, type Side } from './socket.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The paired devices and the one socket each of them holds. */
    fairyLink: FairyLink
  }
}

/** The slice of the host's session controller this plugin uses, named so it can be faked in tests. */
export interface SessionSender {
  create(request: { readonly cwd?: string; readonly agentPreset?: string }): Promise<{ readonly sessionId: SessionId }>
  prompt(
    request: {
      readonly requestId: string
      readonly sessionId: SessionId
      readonly mode: 'queue' | 'steer'
      readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>
    },
    signal: AbortSignal,
  ): Promise<{ readonly accepted: true }>
  list(request: Record<string, never>, signal: AbortSignal): Promise<{ readonly items: ReadonlyArray<{ readonly sessionId: SessionId; readonly updatedAt: number }> }>
}

export interface Config {
  /** Absolute path of the device list (JSON). Tokens are kept there only as hashes. */
  devicesPath: string
  /** Absolute path new conversations of hers live in. */
  sessionCwd: string
  /** The agent preset a new conversation runs. */
  agentPreset: string
  /** Who she is talking to. One owner for now. */
  ownerId: string
  ownerName: string
  /** How long a confirmation waits on a device before the Web UI is asked instead. */
  confirmTimeoutMs: number
}

export const Config: z<Config> = z.object({
  devicesPath: z.string().required().description('Absolute path of the device list (JSON).'),
  sessionCwd: z.string().required().description('Absolute path new conversations live in.'),
  agentPreset: z.string().default('fairy'),
  ownerId: z.string().default('owner'),
  ownerName: z.string().default('主人'),
  confirmTimeoutMs: z.natural().min(1000).default(300_000),
})

/** One connected device. Authenticated only after `hello`. */
interface Conn {
  readonly peer: Peer
  device?: Device
  accepts: Set<Accept>
  sessionId?: SessionId
  /** What the model has said in the turn being assembled, for the next `reply.done`. */
  reply: string
}

/** What a confirmation is waiting on, keyed by the id the device was shown. */
interface Pending {
  done(answer: { selected: string[]; custom?: string } | undefined): void
}

const PREFIX = 'dsh-session:'
const BODY_LIMIT = 4096

function randomId(prefix: string): string {
  return `${prefix}${randomBytes(8).toString('hex')}`
}

function send(conn: Conn, message: HostMessage): void {
  conn.peer.send(encode(message))
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function body(req: IncomingMessage): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += bytes.length
    if (size > BODY_LIMIT) throw new Error('the request body is too large')
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** A device's public face: never the token, never the hash. */
function publicDevice(device: Device): { id: string; name: string; kind: DeviceKind; createdAt: number } {
  return { id: device.id, name: device.name, kind: device.kind, createdAt: device.createdAt }
}

/**
 * Fairy's channel to her devices, mounted once on the host on the Web server she already has:
 * a pairing route, and one WebSocket per device carrying the owner's words into a DeepSeek
 * Harness session and her confirmations back out.
 *
 * Nothing here decides anything about her: the session controller owns conversations, the question
 * waterfall owns asking humans, and her life is written by the session's own presence. This service
 * only moves the owner's words to the right place and refuses to pretend when it cannot.
 */
export class FairyLink extends Service {
  static readonly inject = ['fairySelf', 'webServer']
  static Config = Config

  private readonly codes = new PairingCodes()
  private readonly conns = new Set<Conn>()
  private readonly bindings = new Map<string, Set<Conn>>()
  private readonly pending = new Map<string, Pending>()
  /** Wrong codes per address, so guessing six digits is not a free loop. */
  private readonly failures = new Map<string, { count: number; until: number }>()
  private store!: DeviceStore

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, 'fairyLink')
  }

  async [Service.init](): Promise<void> {
    this.store = DeviceStore.open(this.config.devicesPath)
    const code = this.codes.mint()
    // On the host's own console, not through the logger: this is for the person at the keyboard,
    // and the host's default log level would swallow it.
    console.log(
      `fairy-link: pairing code ${code.code}, valid until ${new Date(code.expiresAt).toISOString()} — POST it with a device name to /fairy/link/pair`,
    )
    this.ctx.logger.info(`fairy-link: pairing code printed (${code.code.slice(0, 2)}……)`)

    this.ctx.effect(
      () =>
        this.ctx.webServer.register({
          kind: 'exact',
          path: '/fairy/link/pair',
          handler: (req, res) => this.pair(req, res),
        }),
      'fairy-link.pair',
    )

    this.ctx.effect(
      () =>
        this.ctx.webServer.registerUpgrade({
          path: '/fairy/link/v1',
          handler: (req, socket, head) => this.accept(req, socket, head),
        }),
      'fairy-link.socket',
    )

    this.ctx.on('session/event', (session, event) => {
      const bound = this.bindings.get(String(session.id))
      if (!bound || bound.size === 0) return
      if (event.type === 'assistant/message') {
        for (const conn of bound) conn.reply += event.data.message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
        return
      }
      if (event.type !== 'turn/end') return
      for (const conn of bound) {
        const text = conn.reply.trim()
        conn.reply = ''
        if (text) send(conn, { type: 'reply.done', id: randomId('r'), turn: String(event.data.turn), text })
      }
    })

    // She reaches out: tell every device that takes a push. What she said arrives as a normal reply.
    this.ctx.on('fairy/urge', (urge) => {
      if (urge.personId !== this.config.ownerId) return
      for (const conn of this.conns) {
        if (conn.device && conn.accepts.has('push')) send(conn, { type: 'urge', id: randomId('u'), why: urge.why, about: urge.about })
      }
    })

    this.ctx.effect(
      () => () => {
        for (const conn of this.conns) conn.peer.close(1001, 'going away')
        this.conns.clear()
        this.bindings.clear()
      },
      'fairy-link.connections',
    )
  }

  /** The live pairing code, for the owner to read on the console or the Web settings page. */
  pairingCode(): { code: string; expiresAt: number } | undefined {
    return this.codes.peek()
  }

  /** Every paired device, without its token. */
  devices(): readonly Device[] {
    return this.store.list()
  }

  /** Forgets a device; its token stops working at once. */
  revoke(id: string): boolean {
    const gone = this.store.revoke(id)
    if (gone) {
      for (const conn of [...this.conns]) {
        if (conn.device?.id === id) conn.peer.close(4403, 'revoked')
      }
    }
    return gone
  }

  private sender(): SessionSender | undefined {
    return this.ctx.get('sessionController') as SessionSender | undefined
  }

  private bind(conn: Conn, sessionId: SessionId): void {
    if (conn.sessionId) this.bindings.get(String(conn.sessionId))?.delete(conn)
    conn.sessionId = sessionId
    const set = this.bindings.get(String(sessionId)) ?? new Set<Conn>()
    set.add(conn)
    this.bindings.set(String(sessionId), set)
  }

  private unbind(conn: Conn): void {
    if (!conn.sessionId) return
    this.bindings.get(String(conn.sessionId))?.delete(conn)
  }

  // ── pairing ────────────────────────────────────────────────────────────────

  private async pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
    const address = req.socket.remoteAddress ?? 'unknown'
    const failure = this.failures.get(address)
    if (failure && failure.until > Date.now()) return json(res, 429, { error: 'too many wrong codes; wait a few minutes' })

    let asked: { code?: unknown; name?: unknown; kind?: unknown }
    try {
      asked = JSON.parse(await body(req)) as typeof asked
    } catch {
      return json(res, 400, { error: 'the body must be a small JSON object' })
    }
    const deviceName = typeof asked.name === 'string' ? asked.name.trim().slice(0, 64) : ''
    const kind: DeviceKind = asked.kind === 'node' ? 'node' : asked.kind === 'cli' ? 'cli' : 'app'
    if (!deviceName) return json(res, 400, { error: 'the device needs a name' })

    if (!this.codes.redeem(String(asked.code ?? ''))) {
      const next = { count: (failure?.count ?? 0) + 1, until: 0 }
      if (next.count >= 5) next.until = Date.now() + 5 * 60_000
      this.failures.set(address, next)
      this.ctx.logger.warn(`fairy-link: a wrong pairing code from ${address} (${next.count} in a row)`)
      return json(res, 403, { error: 'that code is not valid any more' })
    }
    this.failures.delete(address)
    const { device, token } = this.store.add(deviceName, kind)
    this.ctx.logger.info(`fairy-link: paired "${device.name}" (${device.kind})`)
    return json(res, 200, { protocol: PROTOCOL_VERSION, device: publicDevice(device), token })
  }

  // ── one socket per device ──────────────────────────────────────────────────

  private accept(req: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const peer = acceptUpgrade(req, socket, head)
    if (!peer) return
    const conn: Conn = { peer, accepts: new Set<Accept>(), reply: '' }
    this.conns.add(conn)
    peer.onMessage((raw) => {
      void this.dispatch(conn, raw).catch((error: unknown) => {
        this.ctx.logger.warn('fairy-link: a device request failed', error)
        send(conn, { type: 'error', code: 'bad-shape', message: 'the host could not carry that out' })
      })
    })
    peer.onClose(() => {
      this.conns.delete(conn)
      this.unbind(conn)
    })
  }

  private async dispatch(conn: Conn, raw: string): Promise<void> {
    const parsed = parseClient(raw)
    if (!parsed.ok) return send(conn, { type: 'error', code: parsed.code, message: parsed.reason })
    const message = parsed.message

    if (message.type === 'hello') {
      const device = this.store.authenticate(message.token)
      if (!device) {
        send(conn, { type: 'error', id: message.id, code: 'bad-shape', message: 'that token is not paired with this host' })
        conn.peer.close(4401, 'not paired')
        return
      }
      this.store.touch(device.id)
      conn.device = device
      conn.accepts = new Set<Accept>(message.accepts ?? ['push', 'confirm'])
      const last = this.ctx.fairySelf.lastConversation()
      send(conn, {
        type: 'welcome',
        id: message.id,
        name: this.ctx.fairySelf.identity().name,
        protocol: PROTOCOL_VERSION,
        ...(last?.startsWith(PREFIX) ? { sessionId: last.slice(PREFIX.length) } : {}),
      })
      this.ctx.logger.info(`fairy-link: "${device.name}" connected (${[...conn.accepts].join(', ')})`)
      return
    }

    if (!conn.device) {
      send(conn, { type: 'error', id: message.id, code: 'bad-shape', message: 'say hello with a paired token first' })
      conn.peer.close(4401, 'not paired')
      return
    }

    switch (message.type) {
      case 'say': {
        const sender = this.sender()
        if (!sender) return send(conn, { type: 'error', id: message.id, code: 'bad-shape', message: 'this host has no conversation controller' })
        const signal = new AbortController().signal
        const tell = (sessionId: SessionId) =>
          sender.prompt(
            { requestId: randomId('q'), sessionId, mode: 'queue', content: [{ type: 'text', text: message.text }] },
            signal,
          )
        const target = await this.sessionFor(conn, message.sessionId, sender)
        this.bind(conn, target)
        conn.reply = ''
        try {
          await tell(target)
        } catch (error) {
          // The conversation she remembers may not exist on this host — she moved, or it was
          // deleted. Open a new one rather than leaving the owner staring at an error. A
          // conversation the caller named explicitly is their business, and its failure is told.
          if (message.sessionId) throw error
          const created = await sender.create({ cwd: this.config.sessionCwd, agentPreset: this.config.agentPreset })
          this.bind(conn, created.sessionId)
          await tell(created.sessionId)
        }
        return
      }
      case 'status': {
        const status = this.ctx.fairySelf.status()
        const bond = status.bonds?.[this.config.ownerId]
        send(conn, {
          type: 'status',
          id: message.id,
          status: {
            at: status.at,
            asleep: status.asleep,
            ...(status.doing ? { doing: status.doing } : {}),
            mood: status.mood,
            energy: status.energy,
            ...(bond ? { bond } : {}),
          },
        })
        return
      }
      case 'recall': {
        const found = await this.ctx.fairySelf.remember(message.query, { personId: this.config.ownerId, name: this.config.ownerName })
        send(conn, {
          type: 'recall',
          id: message.id,
          query: message.query,
          memories: found.map((memory) => ({ id: memory.id, clarity: memory.clarity, at: memory.at, text: memory.text })),
        })
        return
      }
      case 'sessions': {
        if (message.action === 'use') {
          this.bind(conn, SessionId(message.sessionId!))
          send(conn, { type: 'sessions', id: message.id, sessions: [], selected: message.sessionId! })
          return
        }
        const sender = this.sender()
        if (!sender) return send(conn, { type: 'error', id: message.id, code: 'bad-shape', message: 'this host has no conversation controller' })
        const listed = await sender.list({}, new AbortController().signal)
        send(conn, {
          type: 'sessions',
          id: message.id,
          sessions: listed.items.map((item) => ({ id: String(item.sessionId), lastAt: item.updatedAt })),
          ...(conn.sessionId ? { selected: String(conn.sessionId) } : {}),
        })
        return
      }
      case 'answer': {
        const waiting = this.pending.get(message.confirm)
        if (!waiting) return send(conn, { type: 'error', id: message.id, code: 'bad-shape', message: 'that confirmation is no longer open' })
        waiting.done({ selected: [...message.selected], ...(message.custom ? { custom: message.custom } : {}) })
        return
      }
    }
  }

  /**
   * The conversation this device speaks into: the one it named, the one it already had, the one
   * the owner last talked in, or a new one. Never a guess: a failed create is the device's error.
   */
  private async sessionFor(conn: Conn, asked: string | undefined, sender: SessionSender): Promise<SessionId> {
    if (asked) return SessionId(asked)
    if (conn.sessionId) return conn.sessionId
    const last = this.ctx.fairySelf.lastConversation()
    if (last?.startsWith(PREFIX)) return SessionId(last.slice(PREFIX.length))
    const created = await sender.create({ cwd: this.config.sessionCwd, agentPreset: this.config.agentPreset })
    return created.sessionId
  }

  // ── asking the owner, on whichever device is in their hand ─────────────────

  /**
   * Offers one question to every device that takes confirmations and waits for an answer.
   * Returns undefined when no device can be asked, or when none answered in time, so the caller
   * falls back to the Web UI rather than leaving the caller's question unanswered here.
   *
   * Called from her presence, inside the agent's context: the `user-questions/request` waterfall is
   * Agent-scoped, so a host-level listener never sees it. That is measured, not assumed — the live
   * check on 2026-11-02 left the guard waiting while the device sat idle.
   */
  async confirm(
    question: { readonly id: string; readonly question: string; readonly header?: string; readonly detail?: string; readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>; readonly multiSelect?: boolean },
    signal?: AbortSignal,
  ): Promise<{ selected: string[]; custom?: string } | undefined> {
    const waiting = [...this.conns].filter((conn) => conn.device && conn.accepts.has('confirm'))
    if (waiting.length === 0 || !question.options?.length) return undefined

    const id = randomId('c')
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(undefined), this.config.confirmTimeoutMs)
      const settle = (value: { selected: string[]; custom?: string } | undefined) => {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(value)
      }
      this.pending.set(id, { done: settle })
      signal?.addEventListener('abort', () => settle(undefined), { once: true })
      for (const conn of waiting) {
        send(conn, {
          type: 'confirm',
          id,
          tool: question.header ?? 'fairy-guard',
          question: question.question,
          ...(question.header ? { header: question.header } : {}),
          ...(question.detail ? { detail: question.detail } : {}),
          why: [],
          options: question.options!.map((option) => ({
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
          ...(question.multiSelect ? { multi: true } : {}),
        })
      }
    })
  }
}

export default FairyLink
