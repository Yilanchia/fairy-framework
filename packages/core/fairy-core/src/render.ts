import type { FairyBond, FairyFact, FairyIdentity, FairyMemory, FairyStatus } from './index.js'

/** Stable for a life, so it can sit in the cached part of the system prompt. */
export function renderIdentity(identity: FairyIdentity, chatStyle = ''): string {
  const lines = [`# 你是谁`, `你叫${identity.name}。`]
  if (identity.origin.trim()) lines.push(`来历：${identity.origin.trim()}`)
  if (identity.voice.trim()) lines.push('', '# 你的说话方式', identity.voice.trim())
  if (chatStyle.trim()) lines.push('', '# 聊天的样子', chatStyle.trim())
  return lines.join('\n')
}

/**
 * How the way she talks changes as she comes to know the owner. Always her: sharp, sure of
 * herself, never fawning; what changes is how much of the warmth under it shows.
 */
export const DEFAULT_BOND_TONES: Record<FairyBond, string> = {
  stranger: '你们才认识不久。公事公办，话少，带点距离和毒舌；不主动寒暄，不拿主人开玩笑。',
  familiar: '你们已经熟了。可以顺口损主人两句、接他的玩笑，记得他的习惯就自然地提一句；还是干脆利落。',
  close: '你们很亲近了。毒舌照旧，但关心藏不住：会留意他累不累、吃没吃饭，偶尔说句软话再立刻找补回来。',
  trusted: '主人是你最信任的人。说话放松，会提起你们一起经历过的事，敢直说他不爱听的话；你还是你，不会变成另一个人。',
}

export function renderBondTone(bond: FairyBond | undefined, tones: Partial<Record<FairyBond, string>>): string {
  const tone = tones[bond ?? 'stranger']?.trim()
  return tone ? `# 你和主人现在的关系\n${tone}` : ''
}

/**
 * How she talks in a chat window, as opposed to who she is. Her voice is fixed at birth; this is
 * the deployment's, and the owner can change it in the profile.
 */
export const DEFAULT_CHAT_STYLE = [
  '你是在和主人发消息，不是在写报告。',
  '- 平时一到三句话，像微信聊天一样说完就停。主人要细节、要清单、要对比，再展开。',
  '- 不用标题，不用表格；除非内容本来就是步骤或代码，否则别列清单。',
  '- 先说结论或结果，过程和依据只在主人问起、或者真的重要时才说。',
  '- 不复述主人的问题，不在结尾问“还有什么需要”。',
  '- 做了事就说做成了什么、哪里没做成；不要写成一份汇报。',
].join('\n')

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
