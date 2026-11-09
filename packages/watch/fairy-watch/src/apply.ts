import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { WatchStore } from './store.js'
import type { FixAction, FixProposal } from './types.js'

/**
 * Applying a repair. This is the only place in Watch that writes outside its own home, so it is
 * deliberately narrow:
 *
 * - only the three SSH option edits are mechanical enough to apply;
 * - only the file Watch was configured to read is touched (never a path the model named);
 * - the original is copied first, every changed line is checked after writing, and any failure
 *   restores the copy;
 * - no service is restarted. Reloading sshd stays a human step, printed for the owner.
 *
 * The tool is named so that the guard classifies it as destructive (`apply`), which means the
 * owner is asked before this ever runs and a refusal wins.
 */

const SUPPORTED = new Set(['ssh_password_authentication', 'ssh_root_login', 'ssh_empty_password'])

export interface ApplyOptions {
  /** The sshd_config Watch was configured to read. Never taken from the proposal. */
  readonly sshdConfig: string
  readonly now: number
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function actionId(now: number, proposalId: string): string {
  return `act-${now.toString(36)}-${createHash('sha256').update(proposalId).digest('hex').slice(0, 6)}`
}

export function applyProposal(store: WatchStore, proposal: FixProposal, options: ApplyOptions): string {
  if (!SUPPORTED.has(proposal.kind)) {
    return `不执行：${proposal.kind} 没有安全的机械改法。先由人处理，或者只把计划留在证据里。`
  }
  if (proposal.changes.length === 0) return '不执行：这个提案没有可直接改的行。'

  const file = options.sshdConfig
  if (!existsSync(file)) return `不执行：找不到 ${file}（权限或路径不对）。`

  let original: string
  try {
    original = readFileSync(file, 'utf8')
  } catch (error) {
    return `不执行：读不到 ${file}（${message(error)}）。`
  }

  // Work out the whole new text before touching the file, so a missing line fails clean.
  let text = original
  const applied: string[] = []
  for (const change of proposal.changes) {
    const lines = text.split('\n')
    const hit = lines.findIndex((line) => line.trim() === change.before)
    if (hit < 0) {
      return `不执行：文件里没有精确匹配的行「${change.before}」，可能已经被改过或被注释掉了。先重新采集再提案。`
    }
    const indent = /^\s*/u.exec(lines[hit]!)?.[0] ?? ''
    lines[hit] = `${indent}${change.after}`
    text = lines.join('\n')
    applied.push(`${change.before} → ${change.after}`)
  }
  if (text === original) return '不执行：没有需要改的地方。'

  const backup = `${file}.fairy-backup-${options.now}`
  let outcome: FixAction['outcome'] = 'applied'
  let detail = applied.join('；')
  try {
    copyFileSync(file, backup)
    writeFileSync(file, text, 'utf8')
    const check = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
    for (const change of proposal.changes) {
      if (!check.includes(change.after)) throw new Error(`写后校验失败：没有找到「${change.after}」`)
    }
  } catch (error) {
    outcome = 'rolled-back'
    detail = `${message(error)}`
    try {
      copyFileSync(backup, file)
    } catch (rollbackError) {
      detail += `；回滚也失败：${message(rollbackError)}`
    }
    store.append({
      type: 'action',
      id: actionId(options.now, proposal.id),
      at: options.now,
      proposalId: proposal.id,
      findingId: proposal.findingId,
      kind: proposal.kind,
      changes: proposal.changes,
      backupPaths: [backup],
      outcome,
      detail,
    })
    return `执行失败，已从备份恢复（${backup}）：${detail}`
  }

  store.append({
    type: 'action',
    id: actionId(options.now, proposal.id),
    at: options.now,
    proposalId: proposal.id,
    findingId: proposal.findingId,
    kind: proposal.kind,
    changes: proposal.changes,
    backupPaths: [backup],
    outcome,
    detail,
  })

  return [
    `已应用 ${proposal.id}：${applied.join('；')}`,
    `备份：${backup}`,
    '没有重启任何服务。确认无误后手动执行：sudo sshd -t && sudo systemctl reload sshd',
    '反悔就用上面的备份覆盖回去，再 reload。',
  ].join('\n')
}
