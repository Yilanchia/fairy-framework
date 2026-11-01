import { readFileSync } from 'node:fs'
import { MemoryIndex, memorySettings, replay, type LifeEvent, type LifeState, type Recollection } from '@isla/life'

/**
 * Reads a life without touching it: no lock, no writes, a half-written last line skipped rather
 * than cut off. Safe to run while she is alive, or on a backup.
 */
export function readLife(path: string): LifeEvent[] {
  const lines = readFileSync(path, 'utf8').split('\n')
  const events: LifeEvent[] = []
  lines.forEach((line, index) => {
    if (!line.trim()) return
    try {
      events.push(JSON.parse(line) as LifeEvent)
    } catch (error) {
      if (lines.slice(index + 1).every((rest) => !rest.trim())) return
      throw new Error(`${path} is corrupt at line ${index + 1}`, { cause: error })
    }
  })
  return events
}

export interface Inspection {
  state: LifeState
  events: number
  /** What a search for the query finds, as she would find it now; nothing is recorded. */
  found: Recollection[]
}

export function inspect(events: readonly LifeEvent[], query: string | undefined, now = Date.now()): Inspection {
  const state = replay([...events])
  if (!state) throw new Error('this life has not been born')
  const index = new MemoryIndex(memorySettings(state.genome))
  for (const event of events) index.add(event)
  const found = query ? index.recall({ text: query, limit: 12 }, Math.max(now, state.at), true) : []
  return { state, events: events.length, found }
}

const CLARITY: Record<Recollection['clarity'], string> = { clear: '清楚', vague: '模糊', faint: '很淡' }

export function formatInspection({ state, events, found }: Inspection, query: string | undefined): string {
  const days = Math.floor((state.at - state.bornAt) / 86_400_000)
  const lines = [`${state.genome.name}，出生 ${days} 天，${events} 个事件，${state.asleep ? '睡着' : '醒着'}`]
  for (const [personId, notes] of Object.entries(state.notes)) {
    const name = state.people[personId]?.name ?? personId
    const all = Object.values(notes)
    if (all.length === 0) continue
    lines.push('', `关于${name}记下的事：`)
    for (const note of all.sort((left, right) => Number(right.pending) - Number(left.pending) || right.at - left.at)) {
      lines.push(`  ${note.pending ? '[还没办] ' : ''}${note.topic}：${note.text}  (${note.eventId})`)
    }
  }
  const beliefs = Object.values(state.beliefs)
  if (beliefs.length > 0) lines.push('', '她对自己的认识：', ...beliefs.map((belief) => `  ${belief.statement}`))
  if (query) {
    lines.push('', `搜索「${query}」：`)
    if (found.length === 0) lines.push('  什么也没找到')
    for (const item of found) {
      lines.push(`  [${item.id}] (${CLARITY[item.clarity]}, 强度 ${item.strength}) ${item.text}${item.where ? `  ← ${item.where}` : ''}`)
    }
  }
  return lines.join('\n')
}
