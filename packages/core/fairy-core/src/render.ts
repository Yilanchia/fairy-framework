import type { FairyFact, FairyIdentity, FairyStatus } from './index.js'

/** Stable for a life, so it can sit in the cached part of the system prompt. */
export function renderIdentity(identity: FairyIdentity): string {
  const lines = [`# 你是谁`, `你叫${identity.name}。`]
  if (identity.origin.trim()) lines.push(`来历：${identity.origin.trim()}`)
  if (identity.voice.trim()) lines.push('', '# 你的说话方式', identity.voice.trim())
  return lines.join('\n')
}

/** Changes from moment to moment; DeepSeek Harness carries it as dynamic context. */
export function renderSelfContext(facts: readonly FairyFact[]): string {
  if (facts.length === 0) return ''
  return [
    '# 你此刻的真实状态（来自你的生命日志）',
    '谈到你自己（心情、精力、在做什么、喜欢什么、经历过什么）时，只能依据下面这些事实；这里没有的，就说不知道或不记得，不要编造。',
    ...facts.map((fact) => `[${fact.id}] ${fact.text}`),
  ].join('\n')
}

export function renderStatus(name: string, status: FairyStatus): string {
  const percent = (value: number) => `${Math.round(value * 100)}%`
  const drives = Object.entries(status.drives)
    .map(([drive, level]) => `${drive} ${percent(level)}`)
    .join(', ')
  return [
    `${name} · ${new Date(status.at).toISOString()}`,
    status.asleep ? '睡着' : `醒着${status.doing ? `，正在${status.doing}` : ''}`,
    `心情 ${status.mood.toFixed(2)}，精力 ${percent(status.energy)}`,
    drives ? `需求：${drives}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
