import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { LifeEvent } from '@isla/life'
import { SemanticIndex, type Embedder } from './semantic.js'

const dir = mkdtempSync(join(tmpdir(), 'fairy-semantic-'))
after(() => rmSync(dir, { recursive: true, force: true }))

/** Words that mean the same thing land on the same axis; enough to tell meaning from wording. */
const AXES: string[][] = [['女朋友', '对象', '小雅'], ['杭州', '城市', '哪'], ['花生', '过敏', '吃'], ['海', '青岛']]
class Meaning implements Embedder {
  readonly model = 'test-meaning'
  calls = 0
  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls++
    return texts.map((text) => Float32Array.from(AXES.map((words) => (words.some((word) => text.includes(word)) ? 1 : 0.05))))
  }
}

const heard = (id: string, text: string) =>
  ({ id, seq: Number(id.slice(1)), at: 0, kind: 'heard', causes: [], payload: { personId: 'owner', text } }) as LifeEvent

test('finds what was meant, not what was worded, and keeps the vectors for next time', async () => {
  const cache = join(dir, 'a.jsonl')
  const embedder = new Meaning()
  const index = new SemanticIndex(embedder, cache)
  index.add([heard('e1', '女朋友叫小雅，在杭州工作'), heard('e2', '周末想去青岛看海'), heard('e3', '我对花生过敏')])
  await index.settle()
  assert.equal(index.size, 3)
  const similar = await index.similar('我对象在哪个城市')
  assert.equal([...similar.keys()][0], 'e1')
  assert.ok(!similar.has('e2'), 'unrelated memories are not close')

  // Reopened, nothing is embedded again; a new memory is.
  const again = new Meaning()
  const reopened = new SemanticIndex(again, cache)
  assert.equal(reopened.size, 3)
  reopened.add([heard('e1', '女朋友叫小雅，在杭州工作'), heard('e4', '不能吃花生')])
  await reopened.settle()
  assert.equal(again.calls, 1)
  assert.equal(reopened.size, 4)
})

test('vectors from another model are embedded again, and a torn line is skipped', async () => {
  const cache = join(dir, 'b.jsonl')
  writeFileSync(cache, `${JSON.stringify({ id: 'e1', model: 'old-model', v: 'AAAA' })}\n{"id":"e2","mod`)
  const index = new SemanticIndex(new Meaning(), cache)
  assert.equal(index.size, 0)
})

test('when embedding fails, recall goes on by words alone', async () => {
  const failing: Embedder = {
    model: 'down',
    async embed() {
      throw new Error('connection refused')
    },
  }
  const warnings: string[] = []
  const index = new SemanticIndex(failing, join(dir, 'c.jsonl'), { backoffMs: 1, logger: { warn: (message) => void warnings.push(message) } })
  index.add([heard('e1', '女朋友叫小雅')])
  await index.settle()
  assert.equal(index.size, 0)
  assert.deepEqual(await index.similar('对象'), new Map())
  assert.ok(warnings.length > 0)
})
