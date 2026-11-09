import type { Baseline, Fact, Finding, Observation } from './types.js'

/**
 * The daily page. Plain Markdown, no template engine: it lands in the owner's workspace and in
 * the report folder, and it must read well without a model touching it.
 */

export interface ReportInput {
  readonly day: string
  readonly at: number
  readonly host: string
  readonly baseline?: Baseline
  readonly observations: Map<string, Observation>
  readonly findings: Finding[]
}

function localTime(at: number): string {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 16)
}

function severityRank(severity: Finding['severity']): number {
  return severity === 'high' ? 0 : severity === 'medium' ? 1 : 2
}

function lineFor(finding: Finding): string {
  return `- **[${finding.severity}] ${finding.title}**（${finding.epistemic === 'observed' ? '读到' : '推断'}，证据 ${finding.observationId}）\n  ${finding.detail}`
}

export function renderReport(input: ReportInput): string {
  const findings = [...input.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity))
  const high = findings.filter((finding) => finding.severity === 'high').length
  const medium = findings.filter((finding) => finding.severity === 'medium').length

  const lines: string[] = []
  lines.push(`# Fairy Watch 日报 · ${input.day}`)
  lines.push('')
  lines.push(`机器：${input.host} · 生成于 ${localTime(input.at)}`)
  lines.push('')
  lines.push('## 一句话')
  lines.push('')
  if (findings.length === 0) {
    lines.push('今天没有值得单独说的变化。')
  } else {
    lines.push(`今天有 ${findings.length} 条要看的：高危 ${high} 条，中危 ${medium} 条。`)
  }
  lines.push('')

  lines.push('## 发现')
  lines.push('')
  if (findings.length === 0) {
    lines.push('（无）')
  } else {
    for (const finding of findings) lines.push(lineFor(finding))
  }
  lines.push('')

  lines.push('## 采集面')
  lines.push('')
  lines.push('| 采集项 | 事实数 | 最后采集 | 命令 |')
  lines.push('|---|---|---|---|')
  for (const [collector, observation] of [...input.observations.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const command = observation.evidence.map((read) => read.command).join('；')
    lines.push(`| ${collector} | ${observation.facts.length} | ${localTime(observation.at)} | ${command} |`)
  }
  lines.push('')

  lines.push('## 基线')
  lines.push('')
  if (input.baseline) {
    lines.push(`最近一次基线：${localTime(input.baseline.at)}，${input.baseline.facts.length} 条事实。`)
  } else {
    lines.push('还没有基线。先跑一次 `watch_baseline`，之后的变化才有"和什么比"可言。')
  }
  lines.push('')

  lines.push('---')
  lines.push('')
  lines.push('所有事实都是只读采集，命令固定；发现带证据编号，可以在 `watch.jsonl` 里查到原文哈希。')
  lines.push('')
  return lines.join('\n')
}

/** Facts as a short, readable list for tool output (not the report file). */
export function summarizeFacts(facts: readonly Fact[]): string {
  if (facts.length === 0) return '（没有读到事实）'
  return facts.map((fact) => `- ${fact.key} = ${fact.value}`).join('\n')
}
