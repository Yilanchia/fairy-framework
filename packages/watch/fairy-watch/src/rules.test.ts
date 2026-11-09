import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { collectorFailed, diffFacts, diffSnapshot } from './rules.js'
import type { Baseline, Fact, Observation } from './types.js'

const at = 1_800_000_000_000

function observation(collector: string, facts: Fact[], exit = 0): Observation {
  return {
    type: 'observation',
    id: `obs-${collector}`,
    at,
    host: 'host',
    collector,
    facts,
    evidence: [{ command: 'fixed', exit, outputSha256: '0' }],
  }
}

function baseline(facts: Fact[]): Baseline {
  return { type: 'baseline', id: 'base-1', at, host: 'host', facts, observationIds: [] }
}

function factsOf(...keys: string[]): Fact[] {
  return keys.map((key) => ({ kind: key.split(':')[0] === 'ssh' ? 'ssh_option' : 'listen_port', key, value: 'x' }))
}

test('a new high-risk port is high and inferred', () => {
  const findings = diffSnapshot(baseline([{ kind: 'listen_port', key: 'tcp:22', value: '0.0.0.0:22' }]), new Map([['ports', observation('ports', [
    { kind: 'listen_port', key: 'tcp:22', value: '0.0.0.0:22' },
    { kind: 'listen_port', key: 'tcp:3306', value: '0.0.0.0:3306' },
  ])]]), { at, backupStaleHours: 36 })

  assert.equal(findings.length, 1)
  assert.equal(findings[0]!.kind, 'new_listen_port')
  assert.equal(findings[0]!.severity, 'high')
  assert.equal(findings[0]!.key, 'tcp:3306')
  assert.equal(findings[0]!.epistemic, 'inferred')
  assert.equal(findings[0]!.observationId, 'obs-ports')
})

test('a new ordinary port is medium', () => {
  const findings = diffSnapshot(baseline([]), new Map([['ports', observation('ports', [{ kind: 'listen_port', key: 'tcp:8081', value: '*:8081' }])]]), {
    at,
    backupStaleHours: 36,
  })
  assert.equal(findings.length, 1)
  assert.equal(findings[0]!.severity, 'medium')
})

test('weak ssh settings are high even without a baseline', () => {
  const findings = diffSnapshot(undefined, new Map([['ssh', observation('ssh', [
    { kind: 'ssh_option', key: 'ssh:passwordauthentication', value: 'yes' },
    { kind: 'ssh_option', key: 'ssh:permitrootlogin', value: 'yes' },
  ])]]), { at, backupStaleHours: 36 })

  assert.deepEqual(
    findings.map((finding) => finding.kind).sort(),
    ['ssh_password_authentication', 'ssh_root_login'],
  )
  assert.equal(findings.every((finding) => finding.epistemic === 'observed'), true)
})

test('more authorized keys than the baseline is a change worth a look', () => {
  const findings = diffSnapshot(
    baseline([{ kind: 'ssh_authorized_key_count', key: 'ssh:authorized_keys:count', value: '1' }]),
    new Map([['ssh', observation('ssh', [
      { kind: 'ssh_option', key: 'ssh:passwordauthentication', value: 'no' },
      { kind: 'ssh_authorized_key_count', key: 'ssh:authorized_keys:count', value: '2' },
    ])]]),
    { at, backupStaleHours: 36 },
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0]!.kind, 'ssh_authorized_keys_changed')
  assert.equal(findings[0]!.severity, 'medium')
})

test('a stale or missing backup is high', () => {
  const findings = diffSnapshot(undefined, new Map([['backup', observation('backup', [
    { kind: 'backup', key: 'backup:age_hours:/data', value: '48' },
    { kind: 'backup', key: 'backup:missing:/media', value: 'not found' },
  ])]]), { at, backupStaleHours: 36 })

  assert.deepEqual(findings.map((finding) => finding.kind).sort(), ['backup_missing', 'backup_stale'])
  assert.equal(findings.every((finding) => finding.severity === 'high'), true)
})

test('a collector that failed is not evidence that ports disappeared', () => {
  const failed = observation('ports', [], 1)
  assert.equal(collectorFailed(failed), true)
  assert.deepEqual(diffSnapshot(undefined, new Map([['ports', failed]]), { at, backupStaleHours: 36 }), [])
})

test('the same key is reported once', () => {
  const findings = diffSnapshot(baseline([]), new Map([['ports', observation('ports', [
    { kind: 'listen_port', key: 'tcp:6379', value: '0.0.0.0:6379' },
  ])]]), { at, backupStaleHours: 36 })
  assert.equal(findings.length, 1)
})

test('diffFacts separates added, removed and changed', () => {
  const before = factsOf('tcp:22')
  const after = [
    { kind: 'listen_port', key: 'tcp:22', value: 'now on 127.0.0.1' },
    { kind: 'listen_port', key: 'tcp:80', value: 'x' },
  ]
  const { added, removed, changed } = diffFacts(before, after)
  assert.deepEqual(added.map((fact) => fact.key), ['tcp:80'])
  assert.deepEqual(removed, [])
  assert.equal(changed.length, 1)
})
