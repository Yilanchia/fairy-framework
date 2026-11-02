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
    /**
     * She wants to talk to someone of her own accord. The host's job is to get it to them, e.g.
     * as a turn in the conversation they last had with her.
     * @mode emit
     */
    'fairy/urge'(urge: FairyUrge): void
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
  /** How well she knows each person she has talked to, keyed by person id. */
  readonly bonds?: Readonly<Record<string, FairyBond>>
}

export interface FairySelfEvent {
  readonly id: string
  readonly at: number
  readonly kind: string
}

/** 初识 → 熟悉 → 亲近 → 信赖; only ever deepens. */
export type FairyBond = 'stranger' | 'familiar' | 'close' | 'trusted'

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
  /** Where the conversation it comes from is kept in full. */
  readonly where?: string
}

export interface FairyPerception {
  /** One word for where it came from, e.g. `machine`, `calendar`. */
  readonly source: string
  /** What she noticed, as she would say it. */
  readonly what: string
  /** What it is, so she can come to like or dislike it, e.g. `music`. */
  readonly detail?: string
  /** -1 to 1, the sense's own rating. */
  readonly valence?: number
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
  /**
   * Someone says something to her. She wakes up if she was asleep. `where` says where the whole
   * conversation is kept, e.g. `dsh-session:<id>`.
   */
  abstract hear(person: FairyPerson, text: string, where?: string): Promise<FairyHeard>
  /**
   * Something outside happened and she may notice it; asleep, she does not. For senses: what
   * she feels about it is hers, `valence` only nudges it.
   */
  abstract perceive(perception: FairyPerception): Promise<void>
  /** Records what was said back, so it becomes part of her life. */
  abstract speak(speech: FairySpeech): Promise<void>
  /** She searches her memory on purpose; what she finds stays clearer afterwards. */
  abstract remember(query: string, person?: FairyPerson): Promise<FairyMemory[]>
  /** She keeps something she was told, resting on what `note.source` heard. */
  abstract note(note: FairyNote): Promise<void>
  /**
   * Puts something on one of her shelves for her to get to in her own time.
   * @returns false when she already has it.
   */
  abstract stock(item: FairyShelfItem): Promise<boolean>
  /** Records what she said to someone of her own accord, against the urge it answers. */
  abstract speakUp(urge: FairyUrge, text: string, speaker: string): Promise<void>
}

/** Something for one of her shelves: an article, a commit. */
export interface FairyShelfItem {
  readonly shelf: string
  /** The source's own id, so it is never brought twice. */
  readonly item: string
  readonly title: string
  readonly text: string
  readonly tags?: readonly string[]
  readonly source: string
  readonly link?: string
}

/** She wants to say something to someone who is not talking to her right now. */
export interface FairyUrge extends FairyPerson {
  readonly id: string
  readonly at: number
  /** `missed` her, `share` something she came across, `pending` something she still owes them. */
  readonly why: 'missed' | 'share' | 'pending'
  readonly about: string
}
