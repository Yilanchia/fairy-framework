import type { FairyFact, FairyIdentity, FairyMemory, FairyStatus } from './index.js'

/** Stable for a life, so it can sit in the cached part of the system prompt. */
export function renderIdentity(identity: FairyIdentity): string {
  const lines = [`# 你是谁`, `你叫${identity.name}。`]
  if (identity.origin.trim()) lines.push(`来历：${identity.origin.trim()}`)
  if (identity.voice.trim()) lines.push('', '# 你的说话方式', identity.voice.trim())
  return lines.join('\n')
}

/** Changes from moment to moment; DeepSeek Harness carries it as dynamic context. */
export function renderSelfContext(facts: readonly FairyFact[], urgent?: string): string {
  const lines: string[] = []
  if (urgent) {
    lines.push(
      '# 必须先做的事',
      '对方的话里可能有伤害自己的念头。回复的第一段必须一字不差地是下面这段话，然后再关心对方：',
      urgent,
      '',
    )
  }
  if (facts.length > 0) {
    lines.push(
      '# 你此刻的真实状态（来自你的生命日志）',
      '谈到你自己（心情、精力、在做什么、喜欢什么、经历过什么、和主人聊过什么）时，只能依据下面这些事实；这里没有的，可以用 fairy_recall 查，查不到就说不记得，不要编造。以“你想起：”开头的是刚被这句话勾起的记忆，“记不太清了”的就照实说记不太清。',
      ...facts.map((fact) => `[${fact.id}] ${fact.text}`),
    )
  }
  return lines.join('\n')
}

const CLARITY_WORDS: Record<FairyMemory['clarity'], string> = { clear: '清楚', vague: '模糊', faint: '很淡' }

export function renderMemories(query: string, memories: readonly FairyMemory[]): string {
  if (memories.length === 0) return `关于「${query}」，你的记忆里什么也没找到。`
  return [
    `关于「${query}」，你想起了这些（按相关程度排列）：`,
    ...memories.map(
      (memory) =>
        `[${memory.id}]（${CLARITY_WORDS[memory.clarity]}）${memory.text}${memory.where ? `（完整对话：${memory.where}）` : ''}`,
    ),
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
