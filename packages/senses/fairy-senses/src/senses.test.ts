import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { FairySelf, type FairyPerception, type FairyShelfItem } from '@fairy/core'
import * as senses from './index.js'

/** A self that only remembers what the senses gave it. */
class Watched extends FairySelf {
  readonly seen: FairyPerception[] = []
  readonly stocked: FairyShelfItem[] = []
  identity() {
    return { name: 'Fairy', voice: '', origin: '' }
  }
  status() {
    return { at: 0, asleep: false, mood: 0, energy: 1, drives: {} }
  }
  facts() {
    return []
  }
  async hear() {
    return { id: 'e1' }
  }
  async speak() {}
  async remember() {
    return []
  }
  async note() {}
  async speakUp() {}
  async perceive(perception: FairyPerception) {
    this.seen.push(perception)
  }
  async stock(item: FairyShelfItem) {
    this.stocked.push(item)
    return true
  }
}

test('she looks out of the window when she wakes, and sees the real sky', async (t) => {
  const answers: string[] = []
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    answers.push(String(url))
    return new Response(JSON.stringify({ current_condition: [{ weatherCode: '296', weatherDesc: [{ value: 'Light rain' }], temp_C: '15' }] }))
  })
  const ctx = new Context()
  await ctx.plugin(Watched).await()
  await ctx.plugin(senses, { feeds: [], projects: [], everyMinutes: 60, perSource: 2, weather: { city: '成都', query: 'Chengdu', everyMinutes: 30 } }).await()
  ctx.emit('fairy/self-event', { id: 'e2', at: 0, kind: 'woke' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const self = ctx.fairySelf as Watched
  assert.deepEqual(self.seen, [{ source: 'weather', what: '成都下起了小雨，15℃', detail: '小雨' }])
  assert.match(answers[0]!, /wttr\.in\/Chengdu/)

})

test('without a city she has no weather, and nothing is fetched', async (t) => {
  const fetched = t.mock.method(globalThis, 'fetch', async () => new Response('{}'))
  const ctx = new Context()
  await ctx.plugin(Watched).await()
  await ctx.plugin(senses, { feeds: [], projects: [], everyMinutes: 60, perSource: 2 }).await()
  ctx.emit('fairy/self-event', { id: 'e2', at: 0, kind: 'woke' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(fetched.mock.callCount(), 0)
  assert.deepEqual((ctx.fairySelf as Watched).seen, [])
})
