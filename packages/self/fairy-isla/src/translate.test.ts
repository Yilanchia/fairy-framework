import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRoom, Life, MemoryArchive } from '@isla/life'
import { FAIRY_GENOME } from './genome.js'
import { toFacts, toIdentity, toStatus } from './translate.js'

const HOUR = 60 * 60 * 1000

async function aDayOld(): Promise<Life> {
  // 08:00 Asia/Shanghai, when she is awake.
  let now = Date.UTC(2026, 10, 1, 0)
  const life = await Life.open({
    genome: FAIRY_GENOME,
    world: createRoom({ seed: 'fairy-room' }),
    archive: new MemoryArchive(),
    clock: () => now,
    logger: { warn: () => {} },
  })
  now += 6 * HOUR
  await life.advanceTo(now)
  return life
}

test('the Fairy genome is a valid Isla genome', () => {
  assert.equal(FAIRY_GENOME.name, 'Fairy')
  assert.ok(FAIRY_GENOME.voice.length > 0)
})

test('identity comes from her genome', async () => {
  const life = await aDayOld()
  assert.deepEqual(toIdentity(life.state), {
    name: 'Fairy',
    voice: FAIRY_GENOME.voice,
    origin: FAIRY_GENOME.origin,
  })
})

test('status reflects her lived state', async () => {
  const life = await aDayOld()
  const status = toStatus(life.state)
  assert.equal(status.asleep, life.state.asleep)
  assert.ok(status.energy >= 0 && status.energy <= 1)
  assert.deepEqual(Object.keys(status.drives).sort(), ['connection', 'curiosity', 'expression'])
})

test('facts keep the ids that tie them to her life log', async () => {
  const life = await aDayOld()
  const facts = toFacts(life.facts())
  assert.ok(facts.length > 0)
  const events = new Set(life.events().map((event) => event.id))
  for (const fact of facts) {
    // Isla offers state, genome and event facts; an event id must exist in her log.
    assert.ok(/^(state|genome):/u.test(fact.id) || events.has(fact.id), fact.id)
  }
})
