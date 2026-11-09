import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchStore } from './store.js'
import type { Finding, Observation } from './types.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fairy-watch-store-'))
  return { dir, jsonl: join(dir, 'watch.jsonl'), db: join(dir, 'watch.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const at = 1_800_000_000_000

function observation(): Observation {
  return {
    type: 'observation',
    id: 'obs-1',
    at,
    host: 'host',
    collector: 'ports',
    facts: [{ kind: 'listen_port', key: 'tcp:22', value: '0.0.0.0:22' }],
    evidence: [{ command: 'ss -ltnp', exit: 0, outputSha256: 'abc' }],
  }
}

function finding(): Finding {
  return {
    type: 'finding',
    id: 'find-1',
    at,
    kind: 'new_listen_port',
    severity: 'high',
    key: 'tcp:3306',
    title: '新开的监听端口',
    detail: 'x',
    epistemic: 'inferred',
    observationId: 'obs-1',
    status: 'candidate',
  }
}

test('the view answers from the log', () => {
  const { jsonl, db, cleanup } = fixture()
  const store = new WatchStore(jsonl, db)
  store.append(observation())
  store.append(finding())
  store.append({ type: 'baseline', id: 'base-1', at, host: 'host', facts: observation().facts, observationIds: ['obs-1'] })

  assert.equal(store.latestBaseline()?.id, 'base-1')
  assert.equal(store.latestObservations().get('ports')?.id, 'obs-1')
  assert.deepEqual(store.openFindingKeys(), new Set(['tcp:3306']))
  assert.equal(store.findings('key = ?', 'tcp:3306').length, 1)
  store.close()
  cleanup()
})

test('deleting the view rebuilds it from the log alone', () => {
  const { jsonl, db, cleanup } = fixture()
  const first = new WatchStore(jsonl, db)
  first.append(observation())
  first.close()

  rmSync(db, { force: true })
  const second = new WatchStore(jsonl, db)
  assert.equal(second.latestObservations().get('ports')?.facts.length, 1)
  second.close()
  cleanup()
})

test('a torn last line is skipped instead of failing the open', () => {
  const { jsonl, db, cleanup } = fixture()
  const store = new WatchStore(jsonl, db)
  store.append(observation())
  store.close()
  // Simulate a crash mid-write: a line that never finished.
  appendFileSync(jsonl, '{"type":"observation","id":', 'utf8')

  const reopened = new WatchStore(jsonl, db)
  assert.equal(reopened.latestObservations().size, 1)
  reopened.close()
  cleanup()
})
