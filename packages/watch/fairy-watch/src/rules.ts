import { createHash } from 'node:crypto'
import type { Baseline, Fact, Finding, Observation, Severity } from './types.js'

/**
 * Rules that turn facts into findings. Pure: no files, no processes, no model. A finding always
 * names the observation it rests on, so "why do you think that" has an answer.
 */

/** Ports that are almost never a deliberate new exposure. A new listener here is high. */
const HIGH_RISK_PORTS = new Set([21, 23, 25, 110, 143, 445, 1433, 3306, 3389, 5432, 6379, 8888, 9090, 9200, 27017])

export interface PortChange {
  readonly added: Fact[]
  readonly removed: Fact[]
}

/** Facts keyed by `key`, so two observations of the same thing line up. */
export function mapByKey(facts: readonly Fact[]): Map<string, Fact> {
  return new Map(facts.map((fact) => [fact.key, fact]))
}

/** What appeared, what disappeared, and what stayed but changed. */
export function diffFacts(before: readonly Fact[], after: readonly Fact[]): { added: Fact[]; removed: Fact[]; changed: Array<{ before: Fact; after: Fact }> } {
  const old = mapByKey(before)
  const now = mapByKey(after)
  const added = [...now.values()].filter((fact) => !old.has(fact.key))
  const removed = [...old.values()].filter((fact) => !now.has(fact.key))
  const changed = [...now.values()]
    .filter((fact) => old.has(fact.key) && old.get(fact.key)!.value !== fact.value)
    .map((fact) => ({ before: old.get(fact.key)!, after: fact }))
  return { added, removed, changed }
}

function findingId(at: number, kind: string, key: string): string {
  return `find-${at.toString(36)}-${kind}-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`
}

function finding(
  at: number,
  kind: string,
  key: string,
  severity: Severity,
  title: string,
  detail: string,
  epistemic: Finding['epistemic'],
  observationId: string,
): Finding {
  return { type: 'finding', id: findingId(at, kind, key), at, kind, severity, key, title, detail, epistemic, observationId, status: 'candidate' }
}

/** A collector that failed outright is not evidence that anything disappeared. */
export function collectorFailed(observation: Observation): boolean {
  return observation.evidence.length > 0 && observation.evidence.every((read) => read.exit !== 0)
}

function portFindings(observation: Observation, before: readonly Fact[], at: number): Finding[] {
  const findings: Finding[] = []
  const current = observation.facts.filter((fact) => fact.kind === 'listen_port')
  const { added } = diffFacts(
    before.filter((fact) => fact.kind === 'listen_port'),
    current,
  )
  for (const fact of added) {
    const port = Number(fact.key.split(':')[1])
    const risky = Number.isInteger(port) && HIGH_RISK_PORTS.has(port)
    findings.push(
      finding(
        at,
        'new_listen_port',
        fact.key,
        risky ? 'high' : 'medium',
        `新开的监听端口 ${fact.detail ?? fact.key}`,
        `${fact.value}。和基线比多出来的端口；新开的对外服务通常值得先确认是谁开的。`,
        'inferred',
        observation.id,
      ),
    )
  }
  return findings
}

function sshFindings(observation: Observation, before: readonly Fact[], at: number): Finding[] {
  const findings: Finding[] = []
  const options = new Map(observation.facts.filter((fact) => fact.kind === 'ssh_option').map((fact) => [fact.key, fact]))
  const describe = (fact: Fact | undefined): string => fact?.value ?? '（未读到）'

  const password = options.get('ssh:passwordauthentication')
  if (password && password.value.toLowerCase() === 'yes') {
    findings.push(
      finding(at, 'ssh_password_authentication', 'ssh:passwordauthentication', 'high', 'SSH 允许密码登录', `PasswordAuthentication ${password.value}。密码登录可以被人慢慢猜。`, 'observed', observation.id),
    )
  }
  const root = options.get('ssh:permitrootlogin')
  if (root && /^yes$/i.test(root.value.trim())) {
    findings.push(finding(at, 'ssh_root_login', 'ssh:permitrootlogin', 'high', 'SSH 允许 root 登录', `PermitRootLogin ${root.value}。`, 'observed', observation.id))
  }
  const empty = options.get('ssh:permitemptypasswords')
  if (empty && empty.value.toLowerCase() === 'yes') {
    findings.push(
      finding(at, 'ssh_empty_password', 'ssh:permitemptypasswords', 'high', 'SSH 允许空密码', `PermitEmptyPasswords ${empty.value}。`, 'observed', observation.id),
    )
  }

  const beforeCount = before.find((fact) => fact.key === 'ssh:authorized_keys:count')
  const nowCount = observation.facts.find((fact) => fact.key === 'ssh:authorized_keys:count')
  if (nowCount && Number(nowCount.value) !== Number(beforeCount?.value ?? 0) && beforeCount !== undefined) {
    findings.push(
      finding(
        at,
        'ssh_authorized_keys_changed',
        'ssh:authorized_keys:count',
        'medium',
        'SSH 授权公钥数量变了',
        `从 ${describe(beforeCount)} 条变成 ${nowCount.value} 条。多出来的公钥就是一把能进来的钥匙。`,
        'inferred',
        observation.id,
      ),
    )
  }
  return findings
}

function backupFindings(observation: Observation, at: number, staleHours: number): Finding[] {
  const findings: Finding[] = []
  for (const fact of observation.facts) {
    if (fact.kind !== 'backup') continue
    if (fact.key.startsWith('backup:missing:')) {
      findings.push(finding(at, 'backup_missing', fact.key, 'high', '备份不见了', `${fact.detail ?? fact.key} 下找不到备份文件。`, 'observed', observation.id))
    }
    if (fact.key.startsWith('backup:age_hours:')) {
      const hours = Number(fact.value)
      if (Number.isFinite(hours) && hours > staleHours) {
        findings.push(
          finding(at, 'backup_stale', fact.key, 'high', '备份太旧了', `${fact.detail ?? fact.key} 的最新备份已经 ${hours} 小时没有更新（阈值 ${staleHours} 小时）。`, 'observed', observation.id),
        )
      }
    }
  }
  return findings
}

export interface DiffOptions {
  readonly at: number
  /** A backup older than this is a finding. */
  readonly backupStaleHours: number
}

/**
 * Compare the latest observations with a baseline and apply the rules. Without a baseline the
 * ssh and backup rules still run on what is observed now; only the "new port" rule needs a before.
 */
export function diffSnapshot(baseline: Baseline | undefined, observations: Map<string, Observation>, options: DiffOptions): Finding[] {
  const findings: Finding[] = []
  const before = baseline?.facts ?? []

  const ports = observations.get('ports')
  if (ports && !collectorFailed(ports)) findings.push(...portFindings(ports, before, options.at))

  const ssh = observations.get('ssh')
  if (ssh && ssh.facts.length > 0) findings.push(...sshFindings(ssh, before, options.at))

  const backup = observations.get('backup')
  if (backup) findings.push(...backupFindings(backup, options.at, options.backupStaleHours))

  // A key is one open finding; a repeat run restates nothing.
  const seen = new Set<string>()
  return findings.filter((finding) => {
    if (seen.has(finding.key)) return false
    seen.add(finding.key)
    return true
  })
}
