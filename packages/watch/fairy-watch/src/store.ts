import { DatabaseSync } from 'node:sqlite'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Baseline, Fact, Finding, FixChange, FixProposal, Observation, WatchEvent } from './types.js'

/**
 * The evidence log and its view.
 *
 * `watch.jsonl` is the truth: append-only, one event per line, never edited. The SQLite file is
 * a materialized view rebuilt from it on open — delete it and the next start recreates it. That
 * is the same rule as her life log: the log is the truth, the index is a view.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  host TEXT NOT NULL,
  collector TEXT NOT NULL,
  facts TEXT NOT NULL,
  evidence TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  epistemic TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS baselines (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  host TEXT NOT NULL,
  facts TEXT NOT NULL,
  observation_ids TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  finding_id TEXT NOT NULL,
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  changes TEXT NOT NULL,
  risk TEXT NOT NULL,
  rollback TEXT NOT NULL,
  verify TEXT NOT NULL,
  executable INTEGER NOT NULL,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS proposals_by_finding ON proposals (finding_id);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  proposal_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  changes TEXT NOT NULL,
  backup_paths TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_by_proposal ON actions (proposal_id);
CREATE INDEX IF NOT EXISTS findings_by_key ON findings (key);
CREATE INDEX IF NOT EXISTS findings_by_status ON findings (status);
CREATE INDEX IF NOT EXISTS observations_by_collector ON observations (collector, at);
`

export class WatchStore {
  private readonly db: DatabaseSync

  constructor(
    private readonly jsonlPath: string,
    private readonly dbPath: string,
  ) {
    mkdirSync(dirname(jsonlPath), { recursive: true })
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.rebuild()
  }

  /** Reads the log. A torn last line (a crash mid-write) is skipped, not fatal. */
  events(): WatchEvent[] {
    if (!existsSync(this.jsonlPath)) return []
    const events: WatchEvent[] = []
    for (const line of readFileSync(this.jsonlPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as WatchEvent)
      } catch {
        // Torn tail: the event never finished being written, so it never happened.
      }
    }
    return events
  }

  append(event: WatchEvent): void {
    appendFileSync(this.jsonlPath, `${JSON.stringify(event)}\n`, 'utf8')
    this.insert(event)
  }

  /** Drops the view and replays the log. Always called on open, so the view can never drift. */
  rebuild(): void {
    this.db.exec(
      'DELETE FROM observations; DELETE FROM findings; DELETE FROM baselines; DELETE FROM reports; DELETE FROM proposals; DELETE FROM actions;',
    )
    for (const event of this.events()) this.insert(event)
  }

  private insert(event: WatchEvent): void {
    switch (event.type) {
      case 'observation':
        this.db
          .prepare('INSERT OR REPLACE INTO observations (id, at, host, collector, facts, evidence) VALUES (?, ?, ?, ?, ?, ?)')
          .run(event.id, event.at, event.host, event.collector, JSON.stringify(event.facts), JSON.stringify(event.evidence))
        return
      case 'finding':
        this.db
          .prepare(
            'INSERT OR REPLACE INTO findings (id, at, kind, severity, key, title, detail, epistemic, observation_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            event.id,
            event.at,
            event.kind,
            event.severity,
            event.key,
            event.title,
            event.detail,
            event.epistemic,
            event.observationId,
            event.status,
          )
        return
      case 'baseline':
        this.db
          .prepare('INSERT OR REPLACE INTO baselines (id, at, host, facts, observation_ids) VALUES (?, ?, ?, ?, ?)')
          .run(event.id, event.at, event.host, JSON.stringify(event.facts), JSON.stringify(event.observationIds))
        return
      case 'report':
        this.db.prepare('INSERT OR REPLACE INTO reports (id, at, path) VALUES (?, ?, ?)').run(event.id, event.at, event.path)
        return
      case 'proposal':
        this.db
          .prepare(
            'INSERT OR REPLACE INTO proposals (id, at, finding_id, key, kind, title, changes, risk, rollback, verify, executable, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            event.id,
            event.at,
            event.findingId,
            event.key,
            event.kind,
            event.title,
            JSON.stringify(event.changes),
            event.risk,
            event.rollback,
            event.verify,
            event.executable ? 1 : 0,
            event.reason ?? null,
          )
        return
      case 'action':
        this.db
          .prepare(
            'INSERT OR REPLACE INTO actions (id, at, proposal_id, finding_id, kind, changes, backup_paths, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            event.id,
            event.at,
            event.proposalId,
            event.findingId,
            event.kind,
            JSON.stringify(event.changes),
            JSON.stringify(event.backupPaths),
            event.outcome,
            event.detail,
          )
        return
    }
  }

  /** The most recent baseline, if the owner ever took one. */
  latestBaseline(): Baseline | undefined {
    const row = this.db.prepare('SELECT id, at, host, facts, observation_ids FROM baselines ORDER BY at DESC LIMIT 1').get() as
      | { id: string; at: number; host: string; facts: string; observation_ids: string }
      | undefined
    if (!row) return undefined
    return {
      type: 'baseline',
      id: row.id,
      at: row.at,
      host: row.host,
      facts: JSON.parse(row.facts) as Fact[],
      observationIds: JSON.parse(row.observation_ids) as string[],
    }
  }

  /** The latest observation per collector, so a diff compares like with like. */
  latestObservations(): Map<string, Observation> {
    const rows = this.db
      .prepare(
        `SELECT o.* FROM observations o
         JOIN (SELECT collector, MAX(at) AS at FROM observations GROUP BY collector) latest
           ON o.collector = latest.collector AND o.at = latest.at`,
      )
      .all() as Array<{ id: string; at: number; host: string; collector: string; facts: string; evidence: string }>
    const observations = new Map<string, Observation>()
    for (const row of rows) {
      observations.set(row.collector, {
        type: 'observation',
        id: row.id,
        at: row.at,
        host: row.host,
        collector: row.collector,
        facts: JSON.parse(row.facts) as Fact[],
        evidence: JSON.parse(row.evidence) as Observation['evidence'],
      })
    }
    return observations
  }

  /** Findings that still stand (candidate or verified), newest first. */
  openFindings(): Finding[] {
    return this.findings("status IN ('candidate', 'verified')")
  }

  findings(where = '1 = 1', ...params: Array<string | number>): Finding[] {
    const rows = this.db
      .prepare(
        `SELECT id, at, kind, severity, key, title, detail, epistemic, observation_id, status
         FROM findings WHERE ${where} ORDER BY at DESC`,
      )
      .all(...params) as Array<{
      id: string
      at: number
      kind: string
      severity: string
      key: string
      title: string
      detail: string
      epistemic: string
      observation_id: string
      status: string
    }>
    return rows.map((row) => ({
      type: 'finding',
      id: row.id,
      at: row.at,
      kind: row.kind,
      severity: row.severity as Finding['severity'],
      key: row.key,
      title: row.title,
      detail: row.detail,
      epistemic: row.epistemic as Finding['epistemic'],
      observationId: row.observation_id,
      status: row.status as Finding['status'],
    }))
  }

  /** Keys of findings that still stand, so a repeat run does not restate the same thing. */
  openFindingKeys(): Set<string> {
    const rows = this.db.prepare("SELECT key FROM findings WHERE status IN ('candidate', 'verified')").all() as Array<{ key: string }>
    return new Set(rows.map((row) => row.key))
  }

  /** The newest repair plan for one finding, if one was ever written. */
  proposalFor(findingId: string): FixProposal | undefined {
    const row = this.db
      .prepare('SELECT id, at, finding_id, key, kind, title, changes, risk, rollback, verify, executable, reason FROM proposals WHERE finding_id = ? ORDER BY at DESC LIMIT 1')
      .get(findingId) as
      | {
          id: string
          at: number
          finding_id: string
          key: string
          kind: string
          title: string
          changes: string
          risk: string
          rollback: string
          verify: string
          executable: number
          reason: string | null
        }
      | undefined
    if (!row) return undefined
    return this.toProposal(row)
  }

  /** One plan by its own id, for applying it. */
  proposalById(id: string): FixProposal | undefined {
    const row = this.db
      .prepare('SELECT id, at, finding_id, key, kind, title, changes, risk, rollback, verify, executable, reason FROM proposals WHERE id = ? LIMIT 1')
      .get(id) as
      | {
          id: string
          at: number
          finding_id: string
          key: string
          kind: string
          title: string
          changes: string
          risk: string
          rollback: string
          verify: string
          executable: number
          reason: string | null
        }
      | undefined
    return row ? this.toProposal(row) : undefined
  }

  private toProposal(row: {
    id: string
    at: number
    finding_id: string
    key: string
    kind: string
    title: string
    changes: string
    risk: string
    rollback: string
    verify: string
    executable: number
    reason: string | null
  }): FixProposal {
    return {
      type: 'proposal',
      id: row.id,
      at: row.at,
      findingId: row.finding_id,
      key: row.key,
      kind: row.kind,
      title: row.title,
      changes: JSON.parse(row.changes) as FixChange[],
      risk: row.risk as FixProposal['risk'],
      rollback: row.rollback,
      verify: row.verify,
      executable: row.executable === 1,
      ...(row.reason ? { reason: row.reason } : {}),
    }
  }

  close(): void {
    this.db.close()
  }
}
