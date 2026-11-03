/**
 * The wire between Fairy's host and her devices: one versioned JSON message per WebSocket frame,
 * every message carrying a `type` and a caller-minted `id` that the answer repeats.
 *
 * Both ends validate with the functions here, so neither trusts the other's shape. Nothing in this
 * package imports DeepSeek Harness or reads Fairy's life: it is pure data, shared by the host
 * plugin (`@fairy/link`), the app, and the CLI client.
 */

/** Bumped only when an old client would misread a new host. Both ends refuse a mismatch. */
export const PROTOCOL_VERSION = 1

/** The longest text a device may send in one message. Longer ones are refused, not cut. */
export const MAX_TEXT = 4096

/** The longest identifier either side may mint. */
export const MAX_ID = 128

/** The longest base64 picture one frame may carry (about 700 KiB of pixels). */
export const MAX_IMAGE_CHARS = 960_000

/** The longest text file one message may carry; a bigger one is refused, not cut. */
export const MAX_DOCUMENT_CHARS = 40_000

/** The longest file name a device may send. */
export const MAX_DOCUMENT_NAME = 120

/** What a paired device is: a client the owner types in, a machine node, or the test client. */
export type DeviceKind = 'app' | 'node' | 'cli'

/** What a device can take from the host. A device that cannot confirm still gets everything else. */
export type Accept = 'push' | 'confirm'

/* ── device → host ─────────────────────────────────────────────────────────── */

/** First frame; nothing else is accepted before it. */
export interface Hello {
  readonly type: 'hello'
  readonly id: string
  /** The version the device speaks; a host on another version refuses the frame. */
  readonly protocol: number
  /** The token the pairing code bought. */
  readonly token: string
  readonly device: { readonly name: string; readonly kind: DeviceKind }
  /** Defaults to both when absent. */
  readonly accepts?: readonly Accept[]
}

/** Something the owner said. Without `sessionId` it goes to the conversation last used. */
export interface Say {
  readonly type: 'say'
  readonly id: string
  readonly text: string
  readonly sessionId?: string
  /** Pictures, already resized by the device: base64, no data: prefix. */
  readonly images?: readonly SayImage[]
  /** A small text file — markdown, plain text — read by the device and handed over whole. */
  readonly document?: SayDocument
}

/** A text file the owner picked: its name, and its text. Binary formats do not fit here. */
export interface SayDocument {
  readonly name: string
  readonly text: string
}

/** One picture from the owner, small enough to travel in one frame. */
export interface SayImage {
  /** `image/png`, `image/jpeg` or `image/webp`. */
  readonly mediaType: string
  /** Base64 of the file, without the `data:` prefix. */
  readonly data: string
  readonly name?: string
}

/** What was said so far in one conversation, so a screen that just opened is not blank. */
export interface HistoryRequest {
  readonly type: 'history'
  readonly id: string
  readonly sessionId?: string
  /** How many lines back from the newest; the host caps it. */
  readonly limit?: number
}

/** The owner's answer to one confirmation, in the labels the confirm offered. */
export interface Answer {
  readonly type: 'answer'
  readonly id: string
  /** The `confirm` id from the host. */
  readonly confirm: string
  /** Chosen labels; empty means the owner dismissed it rather than chose. */
  readonly selected: readonly string[]
  /** Free text, when the question allows it. */
  readonly custom?: string
}

/** What she remembers about something, read-only. */
export interface Recall {
  readonly type: 'recall'
  readonly id: string
  readonly query: string
}

/** How she is right now. */
export interface StatusRequest {
  readonly type: 'status'
  readonly id: string
}

/** Which conversations exist, and which one this device speaks into from now on. */
export interface SessionsRequest {
  readonly type: 'sessions'
  readonly id: string
  readonly action: 'list' | 'use'
  /** Only for `use`. */
  readonly sessionId?: string
}

/**
 * The device just got a browser push subscription. The host keeps it and uses it when she wants to
 * say something while no screen is open — the only way her words reach a closed page.
 */
export interface PushSubscribe {
  readonly type: 'push'
  readonly id: string
  readonly subscription: {
    readonly endpoint: string
    readonly keys: { readonly p256dh: string; readonly auth: string }
  }
}

export type ClientMessage = Hello | Say | Answer | Recall | StatusRequest | SessionsRequest | HistoryRequest | PushSubscribe

/* ── host → device ─────────────────────────────────────────────────────────── */

/** Accepts the `hello`; `sessionId` is the conversation this device is attached to. */
export interface Welcome {
  readonly type: 'welcome'
  readonly id: string
  readonly name: string
  readonly protocol: number
  readonly sessionId?: string
  /** The VAPID public key, when this host can push; the page subscribes with it. */
  readonly pushKey?: string
}

/** Her reply as it is being written; a client appends deltas for one `turn`. */
export interface ReplyDelta {
  readonly type: 'reply.delta'
  readonly id: string
  readonly turn: string
  readonly text: string
}

/** Her whole reply for that turn, once it ended. */
export interface ReplyDone {
  readonly type: 'reply.done'
  readonly id: string
  readonly turn: string
  readonly text: string
}

/** She wants to say something on her own, about something in her life. */
export interface Urge {
  readonly type: 'urge'
  readonly id: string
  readonly why: 'missed' | 'share' | 'pending'
  readonly about: string
}

/** Something she wants to do needs the owner's yes, and this device can show it. */
export interface Confirm {
  readonly type: 'confirm'
  readonly id: string
  /** Answer it with `answer.confirm = id`. */
  readonly tool: string
  /** What she is asking, in the words the host wrote. */
  readonly question: string
  readonly header?: string
  readonly detail?: string
  /** Why it needs asking, e.g. 「删除或不可撤销」. */
  readonly why: readonly string[]
  readonly options: readonly { readonly label: string; readonly description?: string }[]
  /** Whether more than one label may be chosen. Defaults to one. */
  readonly multi?: boolean
}

/** How she is. `bond` is absent until they have talked. */
export interface StatusReply {
  readonly type: 'status'
  readonly id: string
  readonly status: {
    readonly at: number
    readonly asleep: boolean
    readonly doing?: string
    readonly mood: number
    readonly energy: number
    readonly bond?: string
  }
}

/** The conversations this host has. */
export interface SessionsReply {
  readonly type: 'sessions'
  readonly id: string
  readonly sessions: readonly { readonly id: string; readonly title?: string; readonly lastAt: number }[]
  /** The one `use` selected, when the request was a `use`. */
  readonly selected?: string
}

/** What she remembers, as she would tell it: the gist, and how clearly. */
export interface RecallReply {
  readonly type: 'recall'
  readonly id: string
  readonly query: string
  readonly memories: readonly {
    readonly id: string
    readonly clarity: 'clear' | 'vague' | 'faint'
    readonly at: number
    readonly text: string
  }[]
}

/** What was said in that conversation, oldest first. */
export interface HistoryReply {
  readonly type: 'history'
  readonly id: string
  readonly sessionId?: string
  readonly lines: readonly { readonly id: string; readonly at: number; readonly who: 'owner' | 'fairy'; readonly text: string }[]
}

/** Something the device asked for did not happen. `id` names the request it answers. */
export interface Failure {
  readonly type: 'error'
  readonly id?: string
  readonly code: ErrorCode
  readonly message: string
}

/** The host took the subscription; `count` is how many it now holds. */
export interface PushAccepted {
  readonly type: 'push.ok'
  readonly id: string
  readonly count: number
}

export type HostMessage = Welcome | ReplyDelta | ReplyDone | Urge | Confirm | StatusReply | SessionsReply | RecallReply | HistoryReply | PushAccepted | Failure

/* ── validation ───────────────────────────────────────────────────────────── */

/** Every way a frame can be refused. Stable strings: clients switch on them. */
export type ErrorCode =
  | 'bad-json'
  | 'bad-shape'
  | 'unknown-type'
  | 'wrong-version'
  | 'too-long'
  | 'empty'

export type Parsed<T> = { readonly ok: true; readonly message: T } | { readonly ok: false; readonly code: ErrorCode; readonly reason: string }

const refuse = (code: ErrorCode, reason: string) => ({ ok: false, code, reason }) as const

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A minted id: non-empty, bounded, and free of control characters. */
export function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isDeviceKind(value: unknown): value is DeviceKind {
  return value === 'app' || value === 'node' || value === 'cli'
}

/** The image types a phone can hand over without the host converting anything. */
export function isImageType(value: unknown): value is string {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp'
}

/** Base64 only, no data: prefix, bounded so one picture fits in a frame. */
function isImageData(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IMAGE_CHARS && /^[A-Za-z0-9+/=]+$/u.test(value)
}

function isClarity(value: unknown): value is 'clear' | 'vague' | 'faint' {
  return value === 'clear' || value === 'vague' || value === 'faint'
}

function hasId(frame: Record<string, unknown>): boolean {
  return isId(frame.id)
}

/**
 * Reads one device frame. The frame's own `type` selects the shape; anything the type does not
 * require is ignored rather than rejected, so adding a field later is not a breaking change.
 */
export function parseClient(raw: string): Parsed<ClientMessage> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return refuse('bad-json', 'the frame is not JSON')
  }
  if (!record(value)) return refuse('bad-shape', 'the frame is not an object')
  if (!hasId(value)) return refuse('bad-shape', 'the frame needs a string id')
  switch (value.type) {
    case 'hello': {
      if (!isId(value.token)) return refuse('bad-shape', 'hello needs a token from pairing')
      if (typeof value.protocol !== 'number') return refuse('bad-shape', 'hello needs a protocol number')
      if (value.protocol !== PROTOCOL_VERSION) return refuse('wrong-version', `this host speaks protocol ${PROTOCOL_VERSION}`)
      if (!record(value.device) || typeof value.device.name !== 'string' || !value.device.name.trim()) {
        return refuse('bad-shape', 'hello needs a device name')
      }
      if (value.device.name.length > 64) return refuse('too-long', 'the device name is longer than 64 characters')
      if (!isDeviceKind(value.device.kind)) return refuse('bad-shape', "device.kind must be 'app', 'node' or 'cli'")
      if (value.accepts !== undefined) {
        if (!Array.isArray(value.accepts) || value.accepts.some((item) => item !== 'push' && item !== 'confirm')) {
          return refuse('bad-shape', "accepts may only hold 'push' and 'confirm'")
        }
      }
      return { ok: true, message: value as unknown as Hello }
    }
    case 'say': {
      const hasImages = Array.isArray(value.images) && value.images.length > 0
      const hasDocument = record(value.document)
      if (typeof value.text !== 'string') return refuse('bad-shape', 'say.text is text')
      if (!value.text.trim() && !hasImages && !hasDocument) return refuse('empty', 'say needs some words, a picture, or a file')
      if (value.text.length > MAX_TEXT) return refuse('too-long', `one message may hold at most ${MAX_TEXT} characters`)
      if (value.sessionId !== undefined && !isId(value.sessionId)) return refuse('bad-shape', 'sessionId is malformed')
      if (value.images !== undefined) {
        if (!Array.isArray(value.images) || value.images.length === 0 || value.images.length > 4) {
          return refuse('bad-shape', 'one message may carry one to four pictures')
        }
        for (const image of value.images) {
          if (!record(image) || !isImageType(image.mediaType) || !isImageData(image.data)) {
            return refuse('bad-shape', 'each picture needs a png/jpeg/webp mediaType and base64 data')
          }
          if (image.name !== undefined && typeof image.name !== 'string') return refuse('bad-shape', 'a picture name must be text')
        }
      }
      if (value.document !== undefined) {
        if (!record(value.document)) return refuse('bad-shape', 'document needs a name and text')
        const name = value.document.name
        const text = value.document.text
        if (typeof name !== 'string' || !name.trim() || name.length > MAX_DOCUMENT_NAME) {
          return refuse('bad-shape', `a file needs a name of at most ${MAX_DOCUMENT_NAME} characters`)
        }
        if (typeof text !== 'string' || !text.trim()) return refuse('empty', 'the file is empty')
        if (text.length > MAX_DOCUMENT_CHARS) {
          return refuse('too-long', `one file may hold at most ${MAX_DOCUMENT_CHARS} characters`)
        }
      }
      return { ok: true, message: value as unknown as Say }
    }
    case 'history': {
      if (value.sessionId !== undefined && !isId(value.sessionId)) return refuse('bad-shape', 'sessionId is malformed')
      if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1)) {
        return refuse('bad-shape', 'limit is a positive whole number of lines')
      }
      return { ok: true, message: value as unknown as HistoryRequest }
    }
    case 'push': {
      const sub = value.subscription
      if (!record(sub) || typeof sub.endpoint !== 'string' || !/^https:\/\//u.test(sub.endpoint) || sub.endpoint.length > 600) {
        return refuse('bad-shape', 'push needs an https subscription endpoint')
      }
      if (!record(sub.keys) || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') {
        return refuse('bad-shape', 'a push subscription needs p256dh and auth keys')
      }
      return { ok: true, message: value as unknown as PushSubscribe }
    }
    case 'answer': {
      if (!isId(value.confirm)) return refuse('bad-shape', 'answer needs the confirm id it answers')
      if (!Array.isArray(value.selected) || value.selected.some((label) => typeof label !== 'string' || !label.trim())) {
        return refuse('bad-shape', 'answer.selected must be the labels the owner picked')
      }
      if (value.selected.length > 8) return refuse('too-long', 'answer.selected holds at most 8 labels')
      if (value.custom !== undefined && (typeof value.custom !== 'string' || value.custom.length > MAX_TEXT)) {
        return refuse('bad-shape', 'answer.custom is malformed')
      }
      return { ok: true, message: value as unknown as Answer }
    }
    case 'recall': {
      if (!isText(value.query)) return refuse('empty', 'recall needs something to look for')
      return { ok: true, message: value as unknown as Recall }
    }
    case 'status': {
      return { ok: true, message: value as unknown as StatusRequest }
    }
    case 'sessions': {
      if (value.action !== 'list' && value.action !== 'use') return refuse('bad-shape', "sessions.action must be 'list' or 'use'")
      if (value.action === 'use' && !isId(value.sessionId)) return refuse('bad-shape', 'sessions action use needs a sessionId')
      return { ok: true, message: value as unknown as SessionsRequest }
    }
    default:
      return refuse('unknown-type', `no device message is called ${JSON.stringify(value.type)}`)
  }
}

/** Reads one host frame. Used by clients; the host never has to trust its own writer, but tests do. */
export function parseHost(raw: string): Parsed<HostMessage> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return refuse('bad-json', 'the frame is not JSON')
  }
  if (!record(value)) return refuse('bad-shape', 'the frame is not an object')
  switch (value.type) {
    case 'welcome': {
      if (!hasId(value) || typeof value.name !== 'string' || typeof value.protocol !== 'number') {
        return refuse('bad-shape', 'welcome needs id, name and protocol')
      }
      if (value.protocol !== PROTOCOL_VERSION) return refuse('wrong-version', `this client speaks protocol ${PROTOCOL_VERSION}`)
      if (value.sessionId !== undefined && !isId(value.sessionId)) return refuse('bad-shape', 'welcome.sessionId is malformed')
      return { ok: true, message: value as unknown as Welcome }
    }
    case 'reply.delta':
    case 'reply.done': {
      if (!hasId(value) || !isId(value.turn) || typeof value.text !== 'string') {
        return refuse('bad-shape', `${String(value.type)} needs id, turn and text`)
      }
      return { ok: true, message: value as unknown as ReplyDelta | ReplyDone }
    }
    case 'urge': {
      if (!hasId(value) || !isText(value.about)) return refuse('bad-shape', 'urge needs id and about')
      if (value.why !== 'missed' && value.why !== 'share' && value.why !== 'pending') return refuse('bad-shape', 'urge.why is unknown')
      return { ok: true, message: value as unknown as Urge }
    }
    case 'confirm': {
      if (!hasId(value) || !isId(value.tool) || !isText(value.question)) {
        return refuse('bad-shape', 'confirm needs id, tool and the question')
      }
      if (!Array.isArray(value.why) || value.why.some((item) => typeof item !== 'string')) return refuse('bad-shape', 'confirm.why must be a list of words')
      if (value.header !== undefined && typeof value.header !== 'string') return refuse('bad-shape', 'confirm.header must be words')
      if (value.detail !== undefined && typeof value.detail !== 'string') return refuse('bad-shape', 'confirm.detail must be words')
      if (!Array.isArray(value.options) || value.options.length === 0 || value.options.length > 8) {
        return refuse('bad-shape', 'confirm.options needs one to eight choices')
      }
      if (value.options.some((option) => !record(option) || typeof option.label !== 'string' || !option.label.trim())) {
        return refuse('bad-shape', 'each choice needs a label')
      }
      if (value.multi !== undefined && typeof value.multi !== 'boolean') return refuse('bad-shape', 'confirm.multi is true or absent')
      return { ok: true, message: value as unknown as Confirm }
    }
    case 'status': {
      if (!hasId(value) || !record(value.status)) return refuse('bad-shape', 'status needs id and status')
      const status = value.status
      if (typeof status.asleep !== 'boolean' || !isTime(status.at) || typeof status.mood !== 'number' || typeof status.energy !== 'number') {
        return refuse('bad-shape', 'status needs at, asleep, mood and energy')
      }
      if (status.doing !== undefined && typeof status.doing !== 'string') return refuse('bad-shape', 'status.doing must be words')
      if (status.bond !== undefined && typeof status.bond !== 'string') return refuse('bad-shape', 'status.bond must be a word')
      return { ok: true, message: value as unknown as StatusReply }
    }
    case 'sessions': {
      if (!hasId(value) || !Array.isArray(value.sessions)) return refuse('bad-shape', 'sessions needs id and a list')
      if (value.sessions.some((row) => !record(row) || !isId(row.id) || !isTime(row.lastAt))) {
        return refuse('bad-shape', 'each session row needs id and lastAt')
      }
      if (value.selected !== undefined && !isId(value.selected)) return refuse('bad-shape', 'sessions.selected is malformed')
      return { ok: true, message: value as unknown as SessionsReply }
    }
    case 'recall': {
      if (!hasId(value) || !Array.isArray(value.memories)) return refuse('bad-shape', 'recall needs id and memories')
      if (value.memories.some((row) => !record(row) || !isId(row.id) || !isClarity(row.clarity) || typeof row.text !== 'string')) {
        return refuse('bad-shape', 'each memory needs id, clarity and text')
      }
      return { ok: true, message: value as unknown as RecallReply }
    }
    case 'history': {
      if (!hasId(value) || !Array.isArray(value.lines)) return refuse('bad-shape', 'history needs id and lines')
      if (value.lines.some((line) => !record(line) || !isId(line.id) || !isTime(line.at) || typeof line.text !== 'string')) {
        return refuse('bad-shape', 'each line needs id, at and text')
      }
      if (value.lines.some((line) => (line as { who?: unknown }).who !== 'owner' && (line as { who?: unknown }).who !== 'fairy')) {
        return refuse('bad-shape', "each line says who said it: 'owner' or 'fairy'")
      }
      if (value.sessionId !== undefined && !isId(value.sessionId)) return refuse('bad-shape', 'history.sessionId is malformed')
      return { ok: true, message: value as unknown as HistoryReply }
    }
    case 'push.ok': {
      if (!hasId(value) || typeof value.count !== 'number' || !Number.isInteger(value.count) || value.count < 0) {
        return refuse('bad-shape', 'push.ok needs id and a whole count')
      }
      return { ok: true, message: value as unknown as PushAccepted }
    }
    case 'error': {
      if (typeof value.code !== 'string' || typeof value.message !== 'string') return refuse('bad-shape', 'error needs code and message')
      if (value.id !== undefined && !isId(value.id)) return refuse('bad-shape', 'error.id is malformed')
      return { ok: true, message: value as unknown as Failure }
    }
    default:
      return refuse('unknown-type', `no host message is called ${JSON.stringify(value.type)}`)
  }
}

/** The frame as it goes on the wire. One JSON object, no newline, nothing trailing. */
export function encode(message: ClientMessage | HostMessage): string {
  return JSON.stringify(message)
}
