/**
 * What her hands may do without asking. Pure, so every rule can be tested without a running
 * harness, and so the rules never depend on her mood: nothing here reads her state.
 *
 * Tiers, from the owner's choice on 2026-11-01:
 * - `destructive`: deleting, overwriting history, formatting, shutting down — cannot be undone.
 * - `outward`: sends something off this machine — pushing, mailing, posting, uploading.
 * - `money`: spends money or handles a secret — payments, keys, passwords in a command.
 * Anything else is `routine` and runs without a question, but is still written to the audit log.
 *
 * These rules are a net, not a sandbox: a determined command can always be phrased to slip past
 * a pattern. They exist so an honest mistake gets a second look, and so the owner can see
 * afterwards what was done.
 */
export type Tier = 'routine' | 'destructive' | 'outward' | 'money'

export interface Verdict {
  tier: Tier
  /** What triggered it, in words the owner reads in the confirmation. Empty for routine. */
  why: string[]
}

export interface ToolCallView {
  name: string
  arguments: unknown
}

type Rule = { tier: Exclude<Tier, 'routine'>; why: string; test: RegExp }

/** Shell commands, PowerShell and POSIX alike. Matched case-insensitively against the whole line. */
const COMMAND_RULES: Rule[] = [
  // Deleting and destroying.
  { tier: 'destructive', why: '删除文件或文件夹', test: /\b(remove-item|rm|rmdir|rd|del|erase|unlink|shred)\b(?![-\w])/i },
  { tier: 'destructive', why: '删除文件或文件夹', test: /\b(ri|rni)\s+[^|;]*-r(ecurse)?\b/i },
  { tier: 'destructive', why: '清空回收站或磁盘', test: /\b(clear-recyclebin|format-volume|diskpart|mkfs(\.\w+)?|cipher\s+\/w)\b|(^|[;&|]\s*)format\s+[a-z]:|\bdd\s+if=/i },
  { tier: 'destructive', why: '改写或丢弃 git 历史', test: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f[a-z]*|push\s+[^|;]*(--force|-f\b)|branch\s+-D|checkout\s+--\s|restore\s+[^|;]*--worktree|stash\s+(drop|clear)|reflog\s+expire|filter-branch|rebase)/i },
  { tier: 'destructive', why: '修改注册表或系统设置', test: /\b(reg(\.exe)?\s+(add|delete|import)|remove-itemproperty|set-itemproperty|new-itemproperty|bcdedit|set-executionpolicy)\b/i },
  { tier: 'destructive', why: '关机、重启或结束进程', test: /\b(shutdown|restart-computer|stop-computer|logoff|reboot|stop-process|taskkill|killall|kill)\b/i },
  { tier: 'destructive', why: '卸载软件或停用服务', test: /\b(uninstall-package|winget\s+uninstall|choco\s+uninstall|stop-service|remove-service|sc(\.exe)?\s+(delete|stop)|msiexec\s+\/x)\b/i },
  { tier: 'destructive', why: '镜像同步会删掉目标里多出来的文件', test: /\brobocopy\b[^|;]*\/(mir|purge)\b/i },
  // Sending things away.
  { tier: 'outward', why: '推送代码到远端', test: /\bgit\s+push\b|\bgh\s+(pr|issue|release|repo|gist)\s+(create|edit|merge|comment|delete|close)\b/i },
  { tier: 'outward', why: '发送邮件或消息', test: /\b(send-mailmessage|sendmail|mailx?|msmtp)\b|smtp/i },
  { tier: 'outward', why: '向外发送数据', test: /\b(invoke-webrequest|invoke-restmethod|iwr|irm|curl|wget|http)\b[^|;]*(-method\s+(post|put|patch|delete)|-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s|-F\s|--upload-file|-T\s|-infile|-body)/i },
  { tier: 'outward', why: '上传或发布', test: /\b(scp|sftp|rsync|ftp|npm\s+publish|pnpm\s+publish|yarn\s+publish|twine\s+upload|docker\s+push|az\s+storage|aws\s+s3\s+(cp|sync|mv))\b/i },
  // Money and secrets.
  { tier: 'money', why: '可能涉及付款或下单', test: /\b(payment|pay|purchase|place-?order|stripe|alipay|wechatpay|paypal)\b|支付|付款|下单|购买|充值/i },
  { tier: 'money', why: '命令里有密码或密钥', test: /\b(api[_-]?key|secret|token|password|passwd|bearer|private[_-]?key)\b|authorization:|pwd=|BEGIN [A-Z ]*PRIVATE KEY|\bsk-[A-Za-z0-9]{16,}/i },
  { tier: 'money', why: '读取凭据存储', test: /(\.credentials|\bcmdkey\b|get-storedcredential|\bkeychain\b|1password|\bop\s+(read|item)\b|\.ssh[\\/]id_|(^|[\s'"\\/=])\.env(\.\w+)?\b(?!\s*\.)|\.aws[\\/]credentials)/i },
]

/** File paths whose contents are secrets or whose loss is hers. */
const PATH_RULES: Rule[] = [
  { tier: 'money', why: '改动凭据文件', test: /(\.env(\.|$)|\.credentials|[\\/]\.ssh[\\/]|[\\/]\.aws[\\/]|[\\/]\.gnupg[\\/]|id_(rsa|ed25519)|\.pem$|\.key$)/i },
  { tier: 'destructive', why: '改动她自己的生命日志', test: /\.life\.jsonl/i },
  { tier: 'destructive', why: '改动 git 内部文件', test: /[\\/]\.git[\\/]/i },
]

const SHELL_TOOLS = new Set(['bash', 'pwsh', 'powershell', 'shell', 'terminal'])
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
/** Read-only or her own: never asked about. Anything not listed is judged by its arguments. */
const QUIET_TOOLS = new Set([
  'read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write', 'ask_user_question',
  'fairy_status', 'fairy_recall', 'fairy_note', 'fairy_reach_out', 'compact',
  'schedule_list', 'schedule_create', 'schedule_update', 'schedule_delete',
])

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function args(call: ToolCallView): Record<string, unknown> {
  return call.arguments && typeof call.arguments === 'object' ? (call.arguments as Record<string, unknown>) : {}
}

const RANK: Record<Tier, number> = { routine: 0, outward: 1, money: 2, destructive: 3 }

function verdictOf(hits: Rule[]): Verdict {
  if (hits.length === 0) return { tier: 'routine', why: [] }
  const tier = hits.reduce<Tier>((best, hit) => (RANK[hit.tier] > RANK[best] ? hit.tier : best), 'routine')
  return { tier, why: [...new Set(hits.map((hit) => hit.why))] }
}

/** Decides how risky one tool call is. */
export function judge(call: ToolCallView): Verdict {
  const name = call.name.toLowerCase()
  if (QUIET_TOOLS.has(name)) return { tier: 'routine', why: [] }
  const input = args(call)
  if (SHELL_TOOLS.has(name)) {
    const command = text(input.command)
    return verdictOf(COMMAND_RULES.filter((rule) => rule.test.test(command)))
  }
  if (WRITE_TOOLS.has(name)) {
    const path = text(input.file_path) || text(input.path)
    const hits = PATH_RULES.filter((rule) => rule.test.test(path))
    const body = `${text(input.content)}\n${text(input.new_string)}`
    if (/sk-[A-Za-z0-9]{16,}|BEGIN [A-Z ]*PRIVATE KEY/.test(body)) {
      hits.push({ tier: 'money', why: '写入的内容里有密钥', test: /./ })
    }
    return verdictOf(hits)
  }
  // A tool from a plugin or an MCP server she was given later: judge it by its name, since its
  // arguments are free text (a search for "how to send mail" sends nothing).
  return verdictOf(
    [
      { tier: 'destructive', why: `「${call.name}」可能删除或覆盖东西`, test: /(^|_|\b)(delete|remove|drop|destroy|wipe|purge|truncate|uninstall|kill|reset|overwrite)(_|\b|$)/i },
      { tier: 'outward', why: `「${call.name}」可能向外发送`, test: /(^|_|\b)(send|post|publish|push|upload|share|tweet|email|mail|message|notify|invite|comment|reply)(_|\b|$)/i },
      { tier: 'money', why: `「${call.name}」可能花钱或动凭据`, test: /(^|_|\b)(pay|buy|purchase|order|checkout|charge|transfer|subscribe|refund|credential|secret|password|token)(_|\b|$)/i },
    ].filter((rule) => rule.test.test(name)) as Rule[],
  )
}

/** One line the owner can read in a confirmation or the audit log. */
export function describeCall(call: ToolCallView, max = 300): string {
  const input = args(call)
  const subject = text(input.command) || text(input.file_path) || text(input.path) || text(input.url) || JSON.stringify(input)
  return subject.length > max ? `${subject.slice(0, max)}…` : subject
}
