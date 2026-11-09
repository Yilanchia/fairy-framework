/**
 * What Fairy Watch keeps about the machine. Every fact here was read with a fixed command or a
 * fixed file read; nothing is written back into the system.
 *
 * The evidence log (`watch.jsonl`) is the truth. The SQLite file is a view that can be deleted
 * and rebuilt from it. Findings are conclusions with a pointer back to the observation they rest
 * on, so a sentence she says about the machine can always be traced.
 */

/** How much a finding deserves the owner's time. */
export type Severity = 'low' | 'medium' | 'high'

/**
 * `observed`: the fact is in the evidence as read. `inferred`: the conclusion follows from
 * comparison or a rule, not from a direct look. Reports must keep the difference visible.
 */
export type Epistemic = 'observed' | 'inferred'

/** A finding's life. A conclusion is never deleted: it stops being true, it does not disappear. */
export type FindingStatus = 'candidate' | 'verified' | 'fixed' | 'invalid'

/** One fact read from the machine, flattened so it can be compared across days. */
export interface Fact {
  /** What kind of thing this is, e.g. `listen_port`, `ssh_option`, `backup_latest`. */
  readonly kind: string
  /** Stable identity, e.g. `tcp:22`, `ssh:passwordauthentication`, `backup:latest`. */
  readonly key: string
  /** The fact as text; may be long but is stored whole (credentials are redacted before this). */
  readonly value: string
  /** Optional short form for reports, e.g. the listening address `0.0.0.0:22`. */
  readonly detail?: string
}

/** What a collector read, and how it knows. */
export interface Evidence {
  /** The exact command (with fixed arguments) or file read. Never a model-written command. */
  readonly command: string
  readonly exit: number
  /** SHA-256 of the raw output, so the same read can be checked later. */
  readonly outputSha256: string
}

export interface Observation {
  readonly type: 'observation'
  readonly id: string
  readonly at: number
  readonly host: string
  /** `ports` | `ssh` | `backup`. */
  readonly collector: string
  readonly facts: readonly Fact[]
  readonly evidence: readonly Evidence[]
}

export interface Finding {
  readonly type: 'finding'
  readonly id: string
  readonly at: number
  /** Rule identity, e.g. `new_listen_port`, `ssh_password_authentication`, `backup_stale`. */
  readonly kind: string
  readonly severity: Severity
  /** Stable fingerprint of the thing the finding is about. */
  readonly key: string
  readonly title: string
  readonly detail: string
  readonly epistemic: Epistemic
  /** The observation it rests on. */
  readonly observationId: string
  readonly status: FindingStatus
}

/** A baseline is a set of observations the owner agreed to treat as "the way it was". */
export interface Baseline {
  readonly type: 'baseline'
  readonly id: string
  readonly at: number
  readonly host: string
  readonly facts: readonly Fact[]
  readonly observationIds: readonly string[]
}

export interface ReportEvent {
  readonly type: 'report'
  readonly id: string
  readonly at: number
  readonly path: string
}

/** One concrete edit a proposal wants to make. Empty for proposals that need a human first. */
export interface FixChange {
  readonly file: string
  readonly before: string
  readonly after: string
  /** Why this line, e.g. "第 42 行". */
  readonly note?: string
}

/**
 * A repair plan for one finding: what would change, how risky it is, how to undo it, how to check
 * it worked. Watch writes the plan and stops there. Applying it is a separate, human-gated step
 * that does not exist in this version on purpose.
 */
export interface FixProposal {
  readonly type: 'proposal'
  readonly id: string
  readonly at: number
  readonly findingId: string
  readonly key: string
  readonly kind: string
  readonly title: string
  readonly changes: readonly FixChange[]
  readonly risk: 'low' | 'medium' | 'high'
  readonly rollback: string
  readonly verify: string
  /** False in this version: Watch never applies a repair by itself. */
  readonly executable: boolean
  /** Why it is not executable, or what a human must decide first. */
  readonly reason?: string
}

export type WatchEvent = Observation | Finding | Baseline | ReportEvent | FixProposal | FixAction

/** What actually happened when a proposal was applied. Kept even when it failed. */
export interface FixAction {
  readonly type: 'action'
  readonly id: string
  readonly at: number
  readonly proposalId: string
  readonly findingId: string
  readonly kind: string
  readonly changes: readonly FixChange[]
  readonly backupPaths: readonly string[]
  readonly outcome: 'applied' | 'rolled-back' | 'failed'
  readonly detail: string
}

/** One pass of the collectors: what is true right now, by collector. */
export interface Snapshot {
  readonly at: number
  readonly host: string
  readonly facts: readonly Fact[]
  /** The observations this snapshot produced, one per collector that ran. */
  readonly observations: readonly Observation[]
}
