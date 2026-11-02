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

export type ClientMessage = Hello | Say | Answer | Recall | StatusRequest | SessionsRequest

/* ── host → device ─────────────────────────────────────────────────────────── */

/** Accepts the `hello`; `sessionId` is the conversation this device is attached to. */
export interface Welcome {
  readonly type: 'welcome'
  readonly id: string
  readonly name: string
  readonly protocol: number
  readonly sessionId?: string
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

/** Something the device asked for did not happen. `id` names the request it answers. */
export interface Failure {
  readonly type: 'error'
  readonly id?: string
  readonly code: ErrorCode
  readonly message: string
}

export type HostMessage = Welcome | ReplyDelta | ReplyDone | Urge | Confirm | StatusReply | SessionsReply | RecallReply | Failure

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
      if (typeof value.text !== 'string' || !value.text.trim()) return refuse('empty', 'say needs some words')
      if (value.text.length > MAX_TEXT) return refuse('too-long', `one message may hold at most ${MAX_TEXT} characters`)
      if (value.sessionId !== undefined && !isId(value.sessionId)) return refuse('bad-shape', 'sessionId is malformed')
      return { ok: true, message: value as unknown as Say }
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
