import { createHash } from 'node:crypto'
import type { Finding, FixChange, FixProposal } from './types.js'

/**
 * Repair plans. A proposal is a piece of writing, not an action: it says what would change, how
 * risky that is, how to undo it and how to check it. Watch does not apply it — `executable` is
 * false in this version on purpose, and the tool that returns it never writes to the system.
 *
 * Plans are per finding kind. A kind with no safe, mechanical edit gets an empty change list and
 * an honest reason instead of a guess.
 */

function idFor(at: number, findingId: string): string {
  return `fix-${at.toString(36)}-${createHash('sha256').update(findingId).digest('hex').slice(0, 8)}`
}

function sshPlan(finding: Finding, before: string, after: string, option: string): FixChange[] {
  return [
    {
      file: 'sshd_config',
      before: `${option} ${before}`,
      after: `${option} ${after}`,
      note: 'Linux 默认 /etc/ssh/sshd_config；实际路径以采集证据为准',
    },
  ]
}

export function buildProposal(finding: Finding, at: number): FixProposal {
  const base = {
    type: 'proposal' as const,
    id: idFor(at, finding.id),
    at,
    findingId: finding.id,
    key: finding.key,
    kind: finding.kind,
    title: finding.title,
  }
  const notExecutable = (reason: string) => ({ executable: false as const, reason })

  switch (finding.kind) {
    case 'ssh_password_authentication':
      return {
        ...base,
        changes: sshPlan(finding, 'yes', 'no', 'PasswordAuthentication'),
        risk: 'medium',
        rollback: 'sudo cp /etc/ssh/sshd_config.fairy-backup /etc/ssh/sshd_config && sudo systemctl reload sshd',
        verify: 'sudo sshd -t && sudo systemctl reload sshd && sudo sshd -T | grep -i passwordauthentication',
        ...notExecutable('改 sshd_config 需要 root 和主人在场；先确认另一条 key 登录可用，否则会把自己锁在门外。这一版只提案，不执行。'),
      }
    case 'ssh_root_login':
      return {
        ...base,
        changes: sshPlan(finding, 'yes', 'prohibit-password', 'PermitRootLogin'),
        risk: 'medium',
        rollback: 'sudo cp /etc/ssh/sshd_config.fairy-backup /etc/ssh/sshd_config && sudo systemctl reload sshd',
        verify: 'sudo sshd -t && sudo systemctl reload sshd && sudo sshd -T | grep -i permitrootlogin',
        ...notExecutable('同样要改 sshd_config；prohibit-password 保留 root 的 key 登录，比直接 no 温和。这一版只提案。'),
      }
    case 'ssh_empty_password':
      return {
        ...base,
        changes: sshPlan(finding, 'yes', 'no', 'PermitEmptyPasswords'),
        risk: 'low',
        rollback: 'sudo cp /etc/ssh/sshd_config.fairy-backup /etc/ssh/sshd_config && sudo systemctl reload sshd',
        verify: 'sudo sshd -t && sudo systemctl reload sshd && sudo sshd -T | grep -i permitemptypasswords',
        ...notExecutable('空密码必须关，但改配置仍要 root 和主人在场。这一版只提案。'),
      }
    case 'ssh_authorized_keys_changed':
      return {
        ...base,
        changes: [],
        risk: 'medium',
        rollback: '把多出来的那行公钥从 authorized_keys 删掉，再确认登录',
        verify: 'ssh-keygen -lf ~/.ssh/authorized_keys（看每一把钥匙的指纹与来源）',
        ...notExecutable('多出来的是一把能进来的钥匙：先人工确认是谁、哪台机器加的，再决定删不删。Watch 不替你删。'),
      }
    case 'new_listen_port': {
      const port = finding.key.split(':')[1] ?? '?'
      return {
        ...base,
        changes: [],
        risk: 'medium',
        rollback: '关掉对应服务（systemctl stop/disable），或把监听地址改回 127.0.0.1',
        verify: `ss -ltnp | grep ':${port}' 与 systemctl status <service>`,
        ...notExecutable('先确认这个端口是谁开的（进程、服务、是不是你刚装的）。该不该关是人的判断，Watch 只给排查命令。'),
      }
    }
    case 'backup_stale':
    case 'backup_missing':
      return {
        ...base,
        changes: [],
        risk: 'low',
        rollback: '不需要回滚：这是检查，不是改动',
        verify: '看备份服务的定时任务与最近一次成功日志；必要时手动跑一次备份',
        ...notExecutable('备份任务不在 Watch 的权限里。先看备份服务是否在跑、目标盘是否有空间。'),
      }
    default:
      return {
        ...base,
        changes: [],
        risk: 'medium',
        rollback: '把相关配置改回原值（执行前先备份）',
        verify: '按 finding 的证据重新采集一次，确认该事实已恢复',
        ...notExecutable('这一类还没有安全的机械改法。先人工判断，或者把这条发现的具体场景告诉维护者。'),
      }
  }
}

/** The plan as the owner reads it. No commands are run while building or printing this. */
export function formatProposal(proposal: FixProposal): string {
  const lines: string[] = []
  lines.push(`修复提案 ${proposal.id}`)
  lines.push(`对应发现：${proposal.title}（${proposal.findingId}）`)
  lines.push('')
  if (proposal.changes.length === 0) {
    lines.push('改什么：没有可以直接改的行——这类问题需要先由人确认。')
  } else {
    lines.push('改什么：')
    for (const change of proposal.changes) {
      lines.push(`- ${change.file}：${change.before}  →  ${change.after}${change.note ? `（${change.note}）` : ''}`)
    }
  }
  lines.push('')
  lines.push(`风险：${proposal.risk}`)
  lines.push(`回滚：${proposal.rollback}`)
  lines.push(`验证：${proposal.verify}`)
  lines.push('')
  lines.push(`能不能自动执行：${proposal.executable ? '能（需主人批准）' : '不能'}`)
  if (proposal.reason) lines.push(`原因：${proposal.reason}`)
  lines.push('')
  lines.push('这一版只提案，不动系统。')
  return lines.join('\n')
}
