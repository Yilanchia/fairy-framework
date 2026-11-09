import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  digest,
  listenFacts,
  parseAuthorizedKeys,
  parseSsListen,
  parseSshdConfig,
  parseWindowsListen,
} from './parse.js'
import type { Evidence, Fact, Observation } from './types.js'

/**
 * Read-only collectors. Every command is fixed here (or is a fixed read of a configured path);
 * nothing the model says can become a command. That is the line that keeps a defence agent from
 * becoming the thing it is supposed to watch.
 */

export interface CollectorConfig {
  readonly ports: boolean
  readonly ssh: boolean
  readonly backup: boolean
  /** Files or directories checked for the newest backup; empty skips the check. */
  readonly backupPaths: readonly string[]
  /** Defaults to the platform's sshd_config when absent. */
  readonly sshdConfig?: string
  /** Defaults to `~/.ssh/authorized_keys` when absent. */
  readonly authorizedKeys?: string
}

export interface RunResult {
  readonly exit: number
  readonly stdout: string
  readonly stderr: string
}

export type Runner = (command: string, args: readonly string[]) => RunResult

export const defaultRunner: Runner = (command, args) => {
  const result = spawnSync(command, [...args], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
  return {
    exit: typeof result.status === 'number' ? result.status : 127,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

interface Read {
  readonly facts: Fact[]
  readonly evidence: Evidence[]
}

function evidenceOf(command: string, result: RunResult): Evidence {
  return { command, exit: result.exit, outputSha256: digest(result.stdout) }
}

function readFileEvidence(command: string, path: string): { text?: string; evidence: Evidence } {
  if (!existsSync(path)) return { evidence: { command, exit: 1, outputSha256: digest('') } }
  try {
    const text = readFileSync(path, 'utf8')
    return { text, evidence: { command, exit: 0, outputSha256: digest(text) } }
  } catch {
    return { evidence: { command, exit: 1, outputSha256: digest('') } }
  }
}

function collectPorts(platform: NodeJS.Platform, runner: Runner): Read {
  if (platform === 'win32') {
    const command =
      'pwsh -NoProfile -Command Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress'
    const result = runner('pwsh', [
      '-NoProfile',
      '-Command',
      'Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress',
    ])
    return { facts: result.exit === 0 ? listenFacts(parseWindowsListen(result.stdout)) : [], evidence: [evidenceOf(command, result)] }
  }
  // Linux: ss is part of iproute2 and does not need root for the socket list.
  const result = runner('ss', ['-ltnp'])
  return { facts: result.exit === 0 ? listenFacts(parseSsListen(result.stdout)) : [], evidence: [evidenceOf('ss -ltnp', result)] }
}

function defaultSshdConfig(platform: NodeJS.Platform): string {
  return platform === 'win32' ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'ssh', 'sshd_config') : '/etc/ssh/sshd_config'
}

function defaultAuthorizedKeys(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
  return join(home, '.ssh', 'authorized_keys')
}

function collectSsh(config: CollectorConfig, platform: NodeJS.Platform): Read {
  const configPath = config.sshdConfig ?? defaultSshdConfig(platform)
  const keysPath = config.authorizedKeys ?? defaultAuthorizedKeys()
  const facts: Fact[] = []
  const evidence: Evidence[] = []

  const sshd = readFileEvidence(`read ${configPath}`, configPath)
  evidence.push(sshd.evidence)
  if (sshd.text !== undefined) facts.push(...parseSshdConfig(sshd.text))

  const keys = readFileEvidence(`read ${keysPath}`, keysPath)
  evidence.push(keys.evidence)
  if (keys.text !== undefined) facts.push(...parseAuthorizedKeys(keys.text))

  return { facts, evidence }
}

function newestUnder(path: string): { at: number; name: string; size: number } | undefined {
  if (!existsSync(path)) return undefined
  try {
    const stat = statSync(path)
    if (stat.isFile()) return { at: stat.mtimeMs, name: path, size: stat.size }
    let newest: { at: number; name: string; size: number } | undefined
    for (const entry of readdirSync(path)) {
      const full = join(path, entry)
      try {
        const row = statSync(full)
        if (!row.isFile()) continue
        if (!newest || row.mtimeMs > newest.at) newest = { at: row.mtimeMs, name: entry, size: row.size }
      } catch {
        // An unreadable entry does not fail the check; it simply is not the newest.
      }
    }
    return newest
  } catch {
    return undefined
  }
}

function collectBackup(config: CollectorConfig): Read | undefined {
  if (config.backupPaths.length === 0) return undefined
  const facts: Fact[] = []
  const evidence: Evidence[] = []
  for (const path of config.backupPaths) {
    const newest = newestUnder(path)
    evidence.push({ command: `stat ${path}`, exit: newest ? 0 : 1, outputSha256: digest(newest ? `${newest.at}:${newest.name}:${newest.size}` : '') })
    if (!newest) {
      facts.push({ kind: 'backup', key: `backup:missing:${path}`, value: 'not found', detail: path })
      continue
    }
    facts.push({
      kind: 'backup',
      key: `backup:latest:${path}`,
      value: `${new Date(newest.at).toISOString()} ${newest.name} ${newest.size}B`,
      detail: path,
    })
    facts.push({ kind: 'backup', key: `backup:age_hours:${path}`, value: String(Math.max(0, Math.round((Date.now() - newest.at) / 3_600_000))) })
  }
  return { facts, evidence }
}

export interface CollectOptions {
  readonly platform?: NodeJS.Platform
  readonly runner?: Runner
  readonly now?: number
}

/** One pass of every enabled collector. Disabled or unconfigured checks simply do not appear. */
export function collectAll(config: CollectorConfig, options: CollectOptions = {}): Observation[] {
  const platform = options.platform ?? process.platform
  const runner = options.runner ?? defaultRunner
  const now = options.now ?? Date.now()
  const host = hostname()
  const reads: Array<[string, Read | undefined]> = []
  if (config.ports) reads.push(['ports', collectPorts(platform, runner)])
  if (config.ssh) reads.push(['ssh', collectSsh(config, platform)])
  if (config.backup) reads.push(['backup', collectBackup(config)])

  return reads
    .filter((entry): entry is [string, Read] => entry[1] !== undefined)
    .map(([collector, read]) => ({
      type: 'observation',
      id: `obs-${now.toString(36)}-${collector}`,
      at: now,
      host,
      collector,
      facts: read.facts,
      evidence: read.evidence,
    }))
}
