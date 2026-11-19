import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import z from '@deepseek-ai/schemastery'
import type {} from '@fairy/core'
import webpush from 'web-push'
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
      readonly content: ReadonlyArray<
        | { readonly type: 'text'; readonly text: string }
        | { readonly type: 'image'; readonly mediaType: string; readonly data: string; readonly name?: string }
      >
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
  /** How long a pairing code lives before a fresh one replaces it. */
  pairCodeMinutes: number
  /**
   * A fixed pairing code the owner keeps. Absent means a rotating six-digit code. A fixed code is
   * only acceptable because it is long, and because repeated failures pause pairing entirely.
   */
  pairCode?: string
  /** Wrong codes, from anywhere, before pairing pauses. */
  pairLockoutFailures: number
  /** How long that pause lasts. */
  pairLockoutMinutes: number
  /**
   * Web Push keys, so her words reach a closed page. Without them nothing subscribes and she can
   * only speak to an open screen.
   */
  vapid?: { publicKey: string; privateKey: string; subject: string }
  /**
   * A webhook for when her browser notification cannot reach the owner — DingTalk, Feishu,
   * ServerChan, PushPlus. `text` posts one plain line; `json` posts { title, body, url, text }.
   */
  notify?: { url: string; format?: 'text' | 'json'; token?: string; method?: string; template?: string }
  /** Her public address, so a notification can carry a link that actually opens. */
  publicUrl?: string
}

export const Config: z<Config> = z.object({
  devicesPath: z.string().required().description('Absolute path of the device list (JSON).'),
  sessionCwd: z.string().required().description('Absolute path new conversations live in.'),
  agentPreset: z.string().default('fairy'),
  ownerId: z.string().default('owner'),
  ownerName: z.string().default('主人'),
  confirmTimeoutMs: z.natural().min(1000).default(300_000),
  pairCodeMinutes: z.natural().min(1).default(5),
  pairCode: z.string().description('A fixed pairing code (at least 12 characters) instead of a rotating one.'),
  pairLockoutFailures: z.natural().min(1).default(20),
  pairLockoutMinutes: z.natural().min(1).default(15),
  vapid: z
    .object({ publicKey: z.string(), privateKey: z.string(), subject: z.string() })
    .description('Web Push keys (VAPID). Without them, she can only speak to an open screen.'),
  notify: z
    .object({ url: z.string(), format: z.union(['text', 'json']), token: z.string(), method: z.string(), template: z.string() })
    .description('A webhook to reach the owner when no browser notification can: DingTalk, Feishu, ServerChan.'),
  publicUrl: z.string().description('Her public address, so a notification can link back to her.'),
})

/** One browser push subscription. `keys` are the ones the browser handed out. */
interface PushRecord {
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
  readonly at: number
}

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

  private readonly codes: PairingCodes
  private readonly conns = new Set<Conn>()
  private readonly bindings = new Map<string, Set<Conn>>()
  private readonly pending = new Map<string, Pending>()
  /** Wrong codes per address, so guessing six digits is not a free loop. */
  private readonly failures = new Map<string, { count: number; until: number }>()
  /** Wrong codes from anywhere, so a fixed long code cannot be hammered from many addresses. */
  private readonly wrong = { count: 0, until: 0 }
  /** Browser push subscriptions; a closed page is the only thing they reach. */
  private records: PushRecord[] = []
  private store!: DeviceStore

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx, 'fairyLink')
    if (config.pairCode !== undefined && config.pairCode.length < 12) {
      throw new Error('fairy-link: pairCode must be at least 12 characters; a short fixed code is guessable forever')
    }
    this.codes = new PairingCodes(config.pairCodeMinutes * 60_000, Date.now, config.pairCode)
  }

  async [Service.init](): Promise<void> {
    this.store = DeviceStore.open(this.config.devicesPath)
    this.loadPush()
    const vapid = this.config.vapid
    if (vapid?.publicKey && vapid.privateKey) {
      try {
        webpush.setVapidDetails(vapid.subject || 'mailto:owner@localhost', vapid.publicKey, vapid.privateKey)
      } catch (error) {
        // Bad keys must not keep her from living; they only mean notifications are off.
        this.ctx.logger.warn('fairy-link: the VAPID keys are not usable; push notifications are off', error)
      }
    }
    this.rotate()
    // A rotating code only works if it keeps coming; a fixed one is written once and left alone.
    if (!this.codes.isFixed) {
      const rotate = setInterval(() => this.rotate(), this.config.pairCodeMinutes * 60_000)
      rotate.unref?.()
      this.ctx.effect(() => () => clearInterval(rotate), 'fairy-link.code')
    }

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

    // She reaches out. An open screen gets the frame; a closed one gets a browser notification,
    // which is the only way her words arrive when nobody is looking at the page.
    this.ctx.on('fairy/urge', (urge) => {
      if (urge.personId !== this.config.ownerId) return
      let told = 0
      for (const conn of this.conns) {
        if (conn.device && conn.accepts.has('push')) {
          send(conn, { type: 'urge', id: randomId('u'), why: urge.why, about: urge.about })
          told += 1
        }
      }
      if (told === 0) void this.notify(urge.why)
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

  /**
   * Mints a fresh code, prints it on the console, and leaves it in a file only her account can
   * read — because the person who wants to pair a phone is not sitting at the server's console.
   */
  rotate(): { code: string; expiresAt: number } {
    const code = this.codes.mint()
    const when = code.expiresAt === 0 ? 'no expiry: this is a fixed code' : `valid until ${new Date(code.expiresAt).toISOString()}`
    console.log(`fairy-link: pairing code ${code.code} — ${when}`)
    try {
      writeFileSync(this.codePath(), `${code.code} ${code.expiresAt}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      this.ctx.logger.warn('fairy-link: could not write the pairing code beside her devices', error)
    }
    return code
  }

  /** Where the launcher and the owner read the current code. */
  private codePath(): string {
    return join(dirname(this.config.devicesPath), 'pairing-code')
  }

  /** Where the browser push subscriptions live, beside her devices. */
  private pushPath(): string {
    return join(dirname(this.config.devicesPath), 'push.json')
  }

  private loadPush(): void {
    try {
      if (!existsSync(this.pushPath())) return
      const rows = JSON.parse(readFileSync(this.pushPath(), 'utf8')) as PushRecord[]
      this.records = Array.isArray(rows) ? rows.filter((row) => typeof row?.endpoint === 'string') : []
    } catch (error) {
      this.ctx.logger.warn('fairy-link: could not read the push subscriptions; starting without them', error)
      this.records = []
    }
  }

  private savePush(): void {
    try {
      writeFileSync(this.pushPath(), `${JSON.stringify(this.records, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      this.ctx.logger.warn('fairy-link: could not save the push subscriptions', error)
    }
  }

  /**
   * The owner is not looking at any screen, so reach them another way: a browser notification if
   * one is subscribed, otherwise (or as well) a webhook — DingTalk, Feishu, ServerChan and the like.
   * Both carry a hint, never her words: push travels through someone else's servers.
   */
  private async notify(why: 'missed' | 'share' | 'pending'): Promise<void> {
    const body =
      why === 'pending' ? '她还有一件答应你的事没办完。' : why === 'share' ? '她看到一样你可能会感兴趣的东西。' : '她有一阵子没和你说话了。'
    const title = 'Fairy 找你'
    const url = `${this.config.publicUrl ?? ''}/fairy/app/`

    if (this.config.vapid?.publicKey && this.records.length > 0) {
      const payload = JSON.stringify({ title, body, url })
      const gone: string[] = []
      for (const record of this.records) {
        try {
          await webpush.sendNotification({ endpoint: record.endpoint, keys: record.keys }, payload)
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode
          // 404/410 mean the browser threw the subscription away; stop trying it.
          if (status === 404 || status === 410) gone.push(record.endpoint)
          else this.ctx.logger.warn('fairy-link: a push notification failed', error)
        }
      }
      if (gone.length > 0) {
        this.records = this.records.filter((record) => !gone.includes(record.endpoint))
        this.savePush()
      }
      return
    }

    const hook = this.config.notify
    if (!hook?.url) return
    const text = `${title}：${body}${this.config.publicUrl ? ` ${url}` : ''}`
    // A template lets one implementation speak DingTalk, Feishu, PushPlus or anything else that
    // wants its own JSON shape. Values are JSON-escaped, so a quote in her words cannot break it.
    const quoted = (value: string) => JSON.stringify(value).slice(1, -1)
    const payload = hook.template
      ? hook.template
          .replaceAll('{{title}}', quoted(title))
          .replaceAll('{{body}}', quoted(body))
          .replaceAll('{{text}}', quoted(text))
          .replaceAll('{{url}}', quoted(url))
      : hook.format === 'text'
        ? text
        : JSON.stringify({ title, body, url, text })
    try {
      const response = await fetch(hook.url, {
        method: hook.method ?? 'POST',
        headers: {
          ...(hook.format === 'text' && !hook.template
            ? { 'content-type': 'text/plain; charset=utf-8' }
            : { 'content-type': 'application/json' }),
          ...(hook.token ? { authorization: `Bearer ${hook.token}` } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) this.ctx.logger.warn(`fairy-link: the notification webhook answered ${response.status}`)
    } catch (error) {
      this.ctx.logger.warn('fairy-link: could not reach the notification webhook', error)
    }
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
    if (this.wrong.until > Date.now()) return json(res, 429, { error: 'pairing is paused after too many wrong codes; try again later' })
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
      this.wrong.count += 1
      if (this.wrong.count >= this.config.pairLockoutFailures) {
        this.wrong.count = 0
        this.wrong.until = Date.now() + this.config.pairLockoutMinutes * 60_000
        this.ctx.logger.warn(
          `fairy-link: ${this.config.pairLockoutFailures} wrong pairing codes; pairing paused for ${this.config.pairLockoutMinutes} minutes`,
        )
      }
      this.ctx.logger.warn(`fairy-link: a wrong pairing code from ${address} (${next.count} in a row)`)
      return json(res, 403, { error: 'that code is not valid any more' })
    }
    this.failures.delete(address)
    this.wrong.count = 0
    const { device, token } = this.store.add(deviceName, kind)
    this.ctx.logger.info(`fairy-link: paired "${device.name}" (${device.kind})`)
    // A rotating code is spent, so hand out the next one; a fixed one is simply kept.
    if (!this.codes.isFixed) this.rotate()
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
      // A window opened while another one is talking joins that conversation on arrival, so her
      // replies reach it without waiting for it to say something first.
      const live = [...this.bindings].find(([, conns]) => conns.size > 0)?.[0]
      if (live) this.bind(conn, SessionId(live))
      const last = live ? `${PREFIX}${live}` : this.ctx.fairySelf.lastConversation()
      const vapid = this.config.vapid
      send(conn, {
        type: 'welcome',
        id: message.id,
        name: this.ctx.fairySelf.identity().name,
        protocol: PROTOCOL_VERSION,
        ...(last?.startsWith(PREFIX) ? { sessionId: last.slice(PREFIX.length) } : {}),
        ...(vapid?.publicKey ? { pushKey: vapid.publicKey } : {}),
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
        const words = message.text.trim()
        // A text file is handed to her as words with a heading, so she reads it as something the
        // owner gave her rather than as something they said.
        const asText = message.document
          ? `${words ? `${words}\n\n` : ''}（主人发来一个文件：${message.document.name}）\n\n${message.document.text}`
          : words
        const content = [
          ...(message.images ?? []).map((image) => ({
            type: 'image' as const,
            mediaType: image.mediaType,
            data: image.data,
            ...(image.name ? { name: image.name } : {}),
          })),
          ...(asText ? [{ type: 'text' as const, text: asText }] : []),
        ]
        const tell = (sessionId: SessionId) =>
          sender.prompt({ requestId: randomId('q'), sessionId, mode: 'queue', content }, signal)
        const target = await this.sessionFor(conn, message.sessionId, sender)
        this.bind(conn, target)
        // Windows that are connected but have not spoken yet follow the conversation that just
        // became active, so her answer reaches them too. One owner, one conversation today.
        for (const other of this.conns) {
          if (other === conn || !other.device || other.sessionId) continue
          this.bind(other, target)
        }
        conn.reply = ''
        // Every other window on this conversation should see the owner's words too, now rather
        // than after she answers. Her reply is broadcast separately when the turn ends.
        const said = message.document
          ? `${words ? `${words}\n\n` : ''}📄 ${message.document.name}（${message.document.text.length} 字）`
          : message.images?.length
            ? `${words ? `${words}\n\n` : ''}［${message.images.length} 张图片］`
            : words
        if (said) {
          // One owner, one conversation today: every other window sees the words, whether or not
          // it has spoken yet. When several conversations exist this narrows to the bound ones.
          for (const other of this.conns) {
            if (other === conn || !other.device) continue
            send(other, { type: 'heard', id: randomId('h'), at: Date.now(), text: said, from: conn.device.name })
          }
        }
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
      case 'history': {
        // Her own record of the conversation, not the harness's session store: what she would say
        // if asked, and what survived the move between machines.
        const where = message.sessionId ? `${PREFIX}${message.sessionId}` : this.ctx.fairySelf.lastConversation()
        const lines = this.ctx.fairySelf.conversation({ ...(where ? { where } : {}), limit: message.limit ?? 40 })
        send(conn, {
          type: 'history',
          id: message.id,
          ...(message.sessionId ? { sessionId: message.sessionId } : {}),
          lines: lines.map((line) => ({ id: line.id, at: line.at, who: line.who, text: line.text.slice(0, 2000) })),
        })
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
      case 'push': {
        if (!this.config.vapid?.publicKey) {
          return send(conn, { type: 'error', id: message.id, code: 'bad-shape', message: 'this host cannot push: no VAPID keys are configured' })
        }
        const endpoint = message.subscription.endpoint
        this.records = this.records.filter((record) => record.endpoint !== endpoint)
        this.records.push({ endpoint, keys: message.subscription.keys, at: Date.now() })
        this.savePush()
        send(conn, { type: 'push.ok', id: message.id, count: this.records.length })
        this.ctx.logger.info(`fairy-link: a browser subscribed to her notifications (${this.records.length} now)`)
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
   * The conversation this device speaks into: the one it named, the one it already had, the
   * conversation another window is in right now, the one the owner last talked in, or a new one.
   *
   * The live session matters: a second device opened while the first is talking should join that
   * conversation, not resolve "last" independently and end up in a different room of her memory.
   */
  private async sessionFor(conn: Conn, asked: string | undefined, sender: SessionSender): Promise<SessionId> {
    if (asked) return SessionId(asked)
    if (conn.sessionId) return conn.sessionId
    for (const [sessionId, conns] of this.bindings) {
      if (conns.size > 0) return SessionId(sessionId)
    }
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
