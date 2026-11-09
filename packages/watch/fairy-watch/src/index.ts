import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { isAbsolute } from 'node:path'
import { WatchStore } from './store.js'
import { registerTools, type WatchConfig } from './tools.js'

export { applyProposal } from './apply.js'
export { collectAll, defaultRunner, type CollectorConfig, type RunResult, type Runner } from './collect.js'
export { listenFacts, parseAuthorizedKeys, parseSshdConfig, parseSsListen, parseWindowsListen } from './parse.js'
export { buildProposal, formatProposal } from './propose.js'
export { diffFacts, diffSnapshot, mapByKey } from './rules.js'
export { renderReport } from './report.js'
export { WatchStore } from './store.js'
export { takeBaseline, takeDiff, proposeFix, applyFix, writeReport, type WatchConfig, type WatchContext } from './tools.js'
export type {
  Baseline,
  Epistemic,
  Fact,
  Finding,
  FindingStatus,
  FixAction,
  FixChange,
  FixProposal,
  Observation,
  Severity,
  Snapshot,
  WatchEvent,
} from './types.js'

/**
 * Fairy Watch: a read-only defence layer for the machine she lives on.
 *
 * It keeps an append-only evidence log next to her life (never inside it), folds it into a
 * SQLite view, takes a baseline, and reports what changed. Every command is fixed here; the model
 * can choose a check and read the result, never write a command. Anything that would change the
 * system is deliberately absent: fixing is a proposal the owner approves, not a tool.
 */
export const name = 'fairy-watch'
export const inject = ['tools']

export interface Config {
  /** Absolute path of the append-only evidence log (JSON Lines). */
  readonly evidencePath: string
  /** Absolute path of the SQLite view; deleting it rebuilds from the log. */
  readonly databasePath: string
  /** Absolute directory the daily Markdown reports are written to. */
  readonly reportDir: string
  readonly ports: boolean
  readonly ssh: boolean
  readonly backup: boolean
  /** Files or directories whose newest file is checked as "the backup". Empty skips the check. */
  readonly backupPaths: string[]
  /** A backup older than this many hours is a finding. */
  readonly backupStaleHours: number
  /** Defaults to the platform's sshd_config. */
  readonly sshdConfig?: string
  /** Defaults to `~/.ssh/authorized_keys`. */
  readonly authorizedKeys?: string
}

export const Config: z<Config> = z.object({
  evidencePath: z.string().required().description('Absolute path of the read-only evidence log (JSON Lines).'),
  databasePath: z.string().required().description('Absolute path of the SQLite view; deleted and rebuilt from the log.'),
  reportDir: z.string().required().description('Absolute directory for the daily Markdown reports.'),
  ports: z.boolean().default(true).description('Collect listening sockets.'),
  ssh: z.boolean().default(true).description('Read sshd_config and authorized_keys.'),
  backup: z.boolean().default(true).description('Check the newest file under backupPaths.'),
  backupPaths: z.array(z.string()).default([]).description('Files or directories to treat as backups.'),
  backupStaleHours: z.natural().default(36).description('A backup older than this many hours is a finding.'),
  sshdConfig: z.string().description('sshd_config path; platform default when absent.'),
  authorizedKeys: z.string().description('authorized_keys path; ~/.ssh/authorized_keys when absent.'),
})

export function apply(ctx: Context, config: Config): void {
  for (const path of [config.evidencePath, config.databasePath, config.reportDir]) {
    if (!isAbsolute(path)) {
      throw new Error(`fairy-watch: expected an absolute path, got ${JSON.stringify(path)}`)
    }
  }

  const store = new WatchStore(config.evidencePath, config.databasePath)
  const watchConfig: WatchConfig = {
    evidencePath: config.evidencePath,
    databasePath: config.databasePath,
    reportDir: config.reportDir,
    ports: config.ports,
    ssh: config.ssh,
    backup: config.backup,
    backupPaths: config.backupPaths,
    backupStaleHours: config.backupStaleHours,
    ...(config.sshdConfig ? { sshdConfig: config.sshdConfig } : {}),
    ...(config.authorizedKeys ? { authorizedKeys: config.authorizedKeys } : {}),
  }

  registerTools(ctx, { store, config: watchConfig })
  ctx.effect(() => () => store.close(), 'fairy-watch.store')

  const enabled = [config.ports ? 'ports' : '', config.ssh ? 'ssh' : '', config.backup ? 'backup' : ''].filter(Boolean)
  ctx.logger.info(
    `fairy-watch: watching ${enabled.length > 0 ? enabled.join('/') : 'nothing'} — evidence ${config.evidencePath}, reports ${config.reportDir}`,
  )
}
