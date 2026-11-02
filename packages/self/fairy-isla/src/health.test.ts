import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatHealth, healthReport, type HealthInput } from './health.js'

const healthy: HealthInput = {
  lifePath: 'D:/x/fairy.life.jsonl',
  events: 238,
  tornTail: false,
  lockHolder: 18980,
  lockHeld: true,
  backupAgeMs: 3 * 3_600_000,
  vectors: true,
  devices: 1,
  port: 3090,
  portOpen: true,
}

test('a running, readable life with a fresh backup is healthy', () => {
  const report = healthReport(healthy)
  assert.equal(report.ok, true)
  assert.match(formatHealth(report), /她没事。/)
})

test('a torn last line is called out as a torn line, not as a unreadable life', () => {
  const report = healthReport({ ...healthy, tornTail: true })
  assert.equal(report.ok, false)
  const line = report.lines.find((row) => row.what === '她的一生')!
  assert.match(line.detail, /最后一行是断的/)
  assert.match(line.detail, /先复制一份/, 'she is not to be edited in place')
})

test('a lock left by a dead process is explained, not treated as a mystery', () => {
  const report = healthReport({ ...healthy, lockHeld: false })
  assert.equal(report.ok, false)
  assert.match(report.lines.find((row) => row.what === '写入者')!.detail, /下次启动会自动接管/)
})

test('a host that has not run for days is told so, and no backups at all is worse', () => {
  assert.match(healthReport({ ...healthy, backupAgeMs: 5 * 86_400_000 }).lines.find((row) => row.what === '每日备份')!.detail, /很久没开了/)
  assert.match(healthReport({ ...healthy, backupAgeMs: undefined }).lines.find((row) => row.what === '每日备份')!.detail, /一份都没有/)
})

test('a life that was never born, a closed port and no device are each said plainly', () => {
  const report = healthReport({ ...healthy, events: undefined, portOpen: false, devices: 0 })
  assert.equal(report.ok, false)
  assert.match(report.lines.find((row) => row.what === '她的一生')!.detail, /第一次启动就是她的出生/)
  assert.match(report.lines.find((row) => row.what === '网页')!.detail, /没应答/)
  assert.match(report.lines.find((row) => row.what === '设备')!.detail, /还没配对设备/)
})

test('without vectors she simply recalls by words, which is fine', () => {
  const report = healthReport({ ...healthy, vectors: false })
  assert.equal(report.ok, true)
  assert.match(report.lines.find((row) => row.what === '按意思回想')!.detail, /只按字面找/)
})
