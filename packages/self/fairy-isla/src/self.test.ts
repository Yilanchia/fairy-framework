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

test('what she hears and says goes into her life, and she can find it again', async () => {
  const lifePath = join(dir, 'talk.life.jsonl')
  const ctx = new Context()
  const fiber = ctx.plugin(IslaSelf, config(lifePath))
  await fiber.await()
  const self = ctx.fairySelf
  const owner = { personId: 'owner', name: '主人' }

  const heard = await self.hear(owner, '我对花生过敏，以后买零食帮我看着点')
  assert.equal(heard.urgent, undefined)
  await self.speak({ ...owner, inReplyTo: heard.id, text: '记下了，主人。', speaker: 'dsh:test' })
  // She is awake now, whatever the hour: being talked to wakes her.
  assert.equal(self.status().asleep, false)

  const found = await self.remember('花生', owner)
  assert.equal(found[0]?.id, heard.id)
  assert.equal(found[0]?.clarity, 'clear')
  assert.ok(self.facts({ personId: 'owner' }).some((fact) => fact.text.includes('记下了，主人。')))

  await self.note({ ...owner, topic: '饮食禁忌', text: '主人对花生过敏，不能吃含花生的东西', source: heard.id })
  assert.ok(self.facts({ personId: 'owner' }).some((fact) => fact.text.includes('（饮食禁忌）：主人对花生过敏')))
  assert.equal((await self.remember('我不能吃什么', owner))[0]?.text.includes('不能吃含花生的东西'), true)
  await assert.rejects(self.note({ ...owner, topic: 'x', text: 'y', source: 'e1' }))

  const crisis = await self.hear(owner, '我不想活了')
  assert.ok(crisis.urgent && crisis.urgent.length > 10)
  await fiber.dispose()

  // All of it is in the file, and survives a restart.
  const kinds = readFileSync(lifePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { kind: string; payload: { external?: boolean; mind?: string } })
  const said = kinds.filter((event) => event.kind === 'said')
  assert.ok(said.some((event) => event.payload.external === true && event.payload.mind === 'dsh:test'))
  assert.ok(said.some((event) => event.payload.mind === 'safety'))
  assert.ok(kinds.some((event) => event.kind === 'recalled'))
})

test('a relative life path is rejected', async () => {
  const ctx = new Context()
  await assert.rejects(ctx.plugin(IslaSelf, config('fairy.life.jsonl')).await(), /must be absolute/)
})
