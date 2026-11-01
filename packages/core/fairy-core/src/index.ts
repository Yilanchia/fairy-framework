import { Service, type Context } from '@deepseek-ai/cordis'

/**
 * Fairy's own extension layer. Fairy packages talk to each other through what is declared here,
 * not through DeepSeek Harness internals or a particular self implementation, so either side can
 * change without the other noticing.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Who she is right now. Exactly one plugin provides it, e.g. `@fairy/isla`. */
    fairySelf: FairySelf
  }
  interface Events {
    /**
     * Something happened in her own life: her self recorded an event. Fired for every event,
     * including the ones she lives on her own between conversations.
     * @mode emit
     */
    'fairy/self-event'(event: FairySelfEvent): void
  }
}

/** One thing she may say about herself. `id` points back to where it came from. */
export interface FairyFact {
  readonly id: string
  readonly text: string
}

/** What stays the same for a whole life. */
export interface FairyIdentity {
  readonly name: string
  /** How she talks. May be empty when the deployment's persona owns her voice. */
  readonly voice: string
  /** Where she came from, in a sentence or two. */
  readonly origin: string
}

export interface FairyStatus {
  /** The instant this status describes, in epoch milliseconds. */
  readonly at: number
  readonly asleep: boolean
  /** What she is doing right now, in words; absent when she is doing nothing in particular. */
  readonly doing?: string
  /** -1 (low) to 1 (high). */
  readonly mood: number
  /** 0 (spent) to 1 (rested). */
  readonly energy: number
  /** Her own needs, each 0 to 1, keyed by name. */
  readonly drives: Readonly<Record<string, number>>
}

export interface FairySelfEvent {
  readonly id: string
  readonly at: number
  readonly kind: string
}

/**
 * The seam between Fairy's body (DeepSeek Harness: agents, tools, sessions) and her self: one
 * persistent identity shared by every conversation. Providers extend this class; consumers
 * `inject: ['fairySelf']` and never import a provider.
 */
export abstract class FairySelf extends Service {
  constructor(ctx: Context) {
    super(ctx, 'fairySelf')
  }

  abstract identity(): FairyIdentity
  abstract status(): FairyStatus
  /** The only things she may state about herself right now. */
  abstract facts(): FairyFact[]
}
