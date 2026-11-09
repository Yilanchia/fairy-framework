import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { applyProposal } from './apply.js'
import { collectAll, type Runner } from './collect.js'
import { buildProposal, formatProposal } from './propose.js'
import { diffFacts, diffSnapshot } from './rules.js'
import { renderReport } from './report.js'
import type { WatchStore } from './store.js'
import type { Baseline, Fact, Observation } from './types.js'

/**
 * The three tools she gets for this machine. They are routine (read-only) as far as the guard is
 * concerned: reading a port list or writing a report inside her own home is not destructive,
 * outward or money. Nothing here can change the system.
 */

export interface WatchConfig {
  readonly evidencePath: string
  readonly databasePath: string
  readonly reportDir: string
  readonly ports: boolean
  readonly ssh: boolean
  readonly backup: boolean
  readonly backupPaths: readonly string[]
  readonly backupStaleHours: number
  readonly sshdConfig?: string
  readonly authorizedKeys?: string
}

export interface WatchContext {
  readonly store: WatchStore
  readonly config: WatchConfig
  readonly runner?: Runner
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
}

function at(ctx: WatchContext): number {
  return ctx.now ? ctx.now() : Date.now()
}

function collectorConfig(config: WatchConfig) {
  return {
    ports: config.ports,
    ssh: config.ssh,
    backup: config.backup,
    backupPaths: config.backupPaths,
    ...(config.sshdConfig ? { sshdConfig: config.sshdConfig } : {}),
    ...(config.authorizedKeys ? { authorizedKeys: config.authorizedKeys } : {}),
  }
}

function collectInto(ctx: WatchContext, now: number): Observation[] {
  const observations = collectAll(collectorConfig(ctx.config), {
    ...(ctx.platform ? { platform: ctx.platform } : {}),
    ...(ctx.runner ? { runner: ctx.runner } : {}),
    now,
  })
  for (const observation of observations) ctx.store.append(observation)
  return observations
}

function factSummary(facts: readonly Fact[]): string {
  const byKind = new Map<string, number>()
  for (const fact of facts) byKind.set(fact.kind, (byKind.get(fact.kind) ?? 0) + 1)
  if (byKind.size === 0) return '0 条事实'
  return [...byKind.entries()].map(([kind, count]) => `${kind} ${count} 条`).join('，')
}

/** Take a baseline: what "the way it was" means from now on. */
export function takeBaseline(ctx: WatchContext): string {
  const now = at(ctx)
  const observations = collectInto(ctx, now)
  if (observations.length === 0) {
    return '没有启用任何采集项，基线是空的。先在配置里打开 ports / ssh / backup，再试。'
  }
  const facts = observations.flatMap((observation) => observation.facts)
  const baseline: Baseline = {
    type: 'baseline',
    id: `base-${now.toString(36)}`,
    at: now,
    host: observations[0]?.host ?? hostname(),
    facts,
    observationIds: observations.map((observation) => observation.id),
  }
  ctx.store.append(baseline)
  const ports = facts.filter((fact) => fact.kind === 'listen_port').length
  return `已记录基线（${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}）：${factSummary(facts)}。其中监听端口 ${ports} 个。之后的变化都以它为参照。`
}

/** Compare what is true now with the latest baseline; record only findings not already open. */
export function takeDiff(ctx: WatchContext): string {
  const now = at(ctx)
  const observations = collectInto(ctx, now)
  const latest = ctx.store.latestObservations()
  if (latest.size === 0) return '这次什么也没采到，先看看采集项和权限。'

  const baseline = ctx.store.latestBaseline()
  const findings = diffSnapshot(baseline, latest, { at: now, backupStaleHours: ctx.config.backupStaleHours })
  const open = ctx.store.openFindingKeys()
  const fresh = findings.filter((finding) => !open.has(finding.key))
  for (const finding of fresh) ctx.store.append(finding)

  const before = baseline?.facts ?? []
  const after = [...latest.values()].flatMap((observation) => observation.facts)
  const { added, removed } = diffFacts(before, after)

  const lines: string[] = []
  if (!baseline) lines.push('还没有基线，这次只能按当前事实跑规则（新端口判不出来）。先 `watch_baseline`，下次起就有"和什么比"了。')
  lines.push(`这次采到 ${observations.length} 个采集项、${after.length} 条事实。`)
  if (added.length > 0) lines.push(`新增：${added.map((fact) => fact.key).join('、')}`)
  if (removed.length > 0) lines.push(`消失：${removed.map((fact) => fact.key).join('、')}`)
  if (fresh.length === 0) {
    lines.push('没有新发现。')
  } else {
    lines.push(`新发现 ${fresh.length} 条：`)
    for (const finding of fresh) lines.push(`- [${finding.severity}] ${finding.title}（${finding.epistemic === 'observed' ? '读到' : '推断'}）：${finding.detail}`)
  }
  return lines.join('\n')
}

function localDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dayBounds(day: string): { start: number; end: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) throw new Error(`日期要写成 YYYY-MM-DD，收到的是 ${day}`)
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime()
  return { start, end: new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1).getTime() }
}

/** Write the daily Markdown page. If today has not been observed yet, collect first. */
export function writeReport(ctx: WatchContext, day?: string): string {
  const now = at(ctx)
  const target = day ?? localDay(now)
  const { start, end } = dayBounds(target)

  let latest = ctx.store.latestObservations()
  const stale = latest.size === 0 || [...latest.values()].every((observation) => observation.at < start || observation.at >= end)
  if (stale) {
    collectInto(ctx, now)
    latest = ctx.store.latestObservations()
  }

  const findings = ctx.store.findings('at >= ? AND at < ?', start, end)
  const host = latest.values().next().value?.host ?? hostname()
  const baseline = ctx.store.latestBaseline()
  const text = renderReport({
    day: target,
    at: now,
    host,
    ...(baseline ? { baseline } : {}),
    observations: latest,
    findings,
  })

  mkdirSync(ctx.config.reportDir, { recursive: true })
  const path = join(ctx.config.reportDir, `${target}.md`)
  writeFileSync(path, text, 'utf8')
  ctx.store.append({ type: 'report', id: `report-${now.toString(36)}`, at: now, path })

  const high = findings.filter((finding) => finding.severity === 'high').length
  return `日报已写到 ${path}（${findings.length} 条发现，其中高危 ${high} 条）。`
}

/** Write a repair plan for one finding. The plan is stored; nothing on the system changes. */
export function proposeFix(ctx: WatchContext, query: { findingId?: string; key?: string }): string {  const now = at(ctx)
  const finding = query.findingId
    ? ctx.store.findings('id = ?', query.findingId)[0]
    : query.key
      ? ctx.store.findings("key = ? AND status IN ('candidate', 'verified')", query.key)[0]
      : undefined

  if (!finding) {
    const open = ctx.store.openFindings().slice(0, 5)
    if (open.length === 0) return '没有可提案的发现。先跑一次 watch_diff。'
    return `没找到那条发现。最近的几条是：\n${open.map((entry) => `- ${entry.id} [${entry.severity}] ${entry.title}`).join('\n')}`
  }

  const proposal = buildProposal(finding, now)
  ctx.store.append(proposal)
  return formatProposal(proposal)
}

function defaultSshdConfig(platform: NodeJS.Platform): string {
  return platform === 'win32' ? join(process.env.ProgramData ?? 'C:\\ProgramData', 'ssh', 'sshd_config') : '/etc/ssh/sshd_config'
}

/** Apply one stored plan. The guard has already asked the owner; a refusal never reaches here. */
export function applyFix(ctx: WatchContext, proposalId: string): string {
  const proposal = ctx.store.proposalById(proposalId)
  if (!proposal) return `没有找到提案 ${proposalId}。先 watch_propose_fix，让它先给出计划。`
  const platform = ctx.platform ?? process.platform
  const sshdConfig = ctx.config.sshdConfig ?? defaultSshdConfig(platform)
  return applyProposal(ctx.store, proposal, { sshdConfig, now: at(ctx) })
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export function registerTools(ctx: Context, watch: WatchContext): void {
  ctx.tools.register(
    defineTool({
      name: 'watch_baseline',
      description:
        'Take a read-only baseline of the machine (listening ports, SSH configuration, backup age). Later diffs compare against it. Nothing is changed on the system.',
      parameters: {},
      output: TEXT_OUTPUT,
      async execute() {
        return takeBaseline(watch)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'watch_diff',
      description:
        'Collect the machine again, compare with the latest baseline, and record findings (new listening ports, weak SSH settings, stale backups). Read-only; every finding points at the observation it came from.',
      parameters: {},
      output: TEXT_OUTPUT,
      async execute() {
        return takeDiff(watch)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'watch_report',
      description:
        'Write the daily Markdown report for a day (default: today) into the report folder and return its path plus a one-line summary. Read-only apart from writing the report file.',
      parameters: {
        day: { type: 'string', description: 'Day to report on, as YYYY-MM-DD. Defaults to today.' },
      },
      output: TEXT_OUTPUT,
      async execute({ day }: { day?: string }) {
        return writeReport(watch, day)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'watch_propose_fix',
      description:
        'Write a repair plan for one finding: what would change, the risk, how to roll it back and how to verify it. It never changes the system; applying a plan is a separate step that needs the owner and does not exist in this version.',
      parameters: {
        findingId: { type: 'string', description: 'Finding id shown by watch_diff or watch_report.' },
        key: { type: 'string', description: 'Or the finding key, e.g. ssh:passwordauthentication.' },
      },
      output: TEXT_OUTPUT,
      async execute({ findingId, key }: { findingId?: string; key?: string }) {
        return proposeFix(watch, { ...(findingId ? { findingId } : {}), ...(key ? { key } : {}) })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'watch_apply_fix',
      description:
        'Apply one stored repair plan to the SSH config. Destructive: the owner is asked to approve it first and a refusal wins. The original file is copied first, every changed line is verified, a failure restores the copy, and no service is restarted.',
      parameters: {
        proposalId: { type: 'string', required: true, description: 'Proposal id returned by watch_propose_fix.' },
      },
      output: TEXT_OUTPUT,
      async execute({ proposalId }: { proposalId: string }) {
        return applyFix(watch, proposalId)
      },
    }),
  )
}
