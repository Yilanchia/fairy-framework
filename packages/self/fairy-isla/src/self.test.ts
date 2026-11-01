import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import IslaSelf, { type Config } from './index.js'

const dir = mkdtempSync(join(tmpdir(), 'fairy-self-'))
after(() => rmSync(dir, { recursive: true, force: true }))

function config(lifePath: string): Config {
  return { lifePath, worldSeed: 'fairy-room', heartbeatMs: 60_000 }
}

function births(lifePath: string): string[] {
  return readFileSync(lifePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string; payload: { lifeId?: string } })
    .filter((event) => event.kind === 'born')
    .map((event) => event.payload.lifeId ?? '')
}

test('her first start is her birth, and she is the same her after a restart', async () => {
  const lifePath = join(dir, 'fairy.life.jsonl')

  const first = new Context()
  const fiber = first.plugin(IslaSelf, config(lifePath))
  await fiber.await()
  assert.equal(first.fairySelf.identity().name, 'Fairy')
  assert.ok(first.fairySelf.facts().length > 0)
  const [lifeId] = births(lifePath)
  assert.ok(lifeId)

  // One writer: a second host on the same life is refused while the first is alive.
  const second = new Context()
  await assert.rejects(second.plugin(IslaSelf, config(lifePath)).await(), /already open/)

  await fiber.dispose()

  const again = new Context()
  const reopened = again.plugin(IslaSelf, config(lifePath))
  await reopened.await()
  assert.deepEqual(births(lifePath), [lifeId], 'reopening must not give birth again')
  assert.equal(again.fairySelf.identity().name, 'Fairy')
  await reopened.dispose()
})

test('a relative life path is rejected', async () => {
  const ctx = new Context()
  await assert.rejects(ctx.plugin(IslaSelf, config('fairy.life.jsonl')).await(), /must be absolute/)
})
