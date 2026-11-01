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

/** Someone she talks with. */
export interface FairyPerson {
  readonly personId: string
  readonly name?: string
}

/** What `hear()` recorded. */
export interface FairyHeard {
  /** Pass to `speak()` as `inReplyTo`. */
  readonly id: string
  /**
   * Words she must say first, exactly as given: the fixed reply when someone seems to be in
   * danger. Absent otherwise.
   */
  readonly urgent?: string
}

export interface FairySpeech extends FairyPerson {
  readonly inReplyTo: string
  readonly text: string
  /** Who put the words together, e.g. `dsh:deepseek-v4`. */
  readonly speaker: string
}

/** Something she decides to keep about someone. */
export interface FairyNote extends FairyPerson {
  /** A short key; a later note on the same topic replaces this one. */
  readonly topic: string
  readonly text: string
  /** The `FairyHeard.id` it comes from. */
  readonly source: string
  /** Still to be done: a request, a promise, a reminder. */
  readonly pending?: boolean
  /** Closes what was pending on this topic. */
  readonly done?: boolean
}

/** One memory as she has it right now. */
export interface FairyMemory {
  readonly id: string
  readonly at: number
  /** `clear`: word for word. `vague`: the gist. `faint`: barely. */
  readonly clarity: 'clear' | 'vague' | 'faint'
  readonly text: string
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
  /**
   * The only things she may state about herself right now. With a `cue` (usually what was just
   * said), older things it brings to mind are included.
   */
  abstract facts(options?: { readonly personId?: string; readonly cue?: string }): FairyFact[]
  /** Someone says something to her. She wakes up if she was asleep. */
  abstract hear(person: FairyPerson, text: string): Promise<FairyHeard>
  /** Records what was said back, so it becomes part of her life. */
  abstract speak(speech: FairySpeech): Promise<void>
  /** She searches her memory on purpose; what she finds stays clearer afterwards. */
  abstract remember(query: string, person?: FairyPerson): Promise<FairyMemory[]>
  /** She keeps something she was told, resting on what `note.source` heard. */
  abstract note(note: FairyNote): Promise<void>
}
