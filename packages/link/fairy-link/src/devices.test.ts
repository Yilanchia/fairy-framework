import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { DeviceStore } from './devices.js'

const dir = mkdtempSync(join(tmpdir(), 'fairy-devices-'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('a paired device is remembered by its token hash, not by its token', () => {
  const path = join(dir, 'devices.json')
  const store = DeviceStore.open(path)
  const { device, token } = store.add('主人的手机', 'app', 1000)
  assert.equal(device.kind, 'app')
  assert.ok(token.length >= 32)
  assert.equal(store.authenticate(token)?.id, device.id)

  // The file is the thing an attacker with disk access would read: it must not be enough.
  const text = readFileSync(path, 'utf8')
  assert.ok(!text.includes(token), 'the token itself is never written')
  assert.ok(text.includes(device.tokenHash))
})

test('a token that was not issued, or a revoked one, opens nothing', () => {
  const path = join(dir, 'revoke.json')
  const store = DeviceStore.open(path)
  const { device, token } = store.add('测试客户端', 'cli', 1000)
  assert.equal(store.authenticate('not-a-token'), undefined)
  assert.equal(store.revoke(device.id), true)
  assert.equal(store.authenticate(token), undefined)
  assert.equal(store.revoke(device.id), false, 'revoking twice is not an error, just nothing')
})

test('paired devices survive a restart, and a second store reads the same file', () => {
  const path = join(dir, 'restart.json')
  const first = DeviceStore.open(path)
  const { device, token } = first.add('NAS', 'node', 1000)
  first.add('主板', 'app', 2000)

  const again = DeviceStore.open(path)
  assert.deepEqual(again.list().map((row) => row.id), first.list().map((row) => row.id))
  assert.equal(again.authenticate(token)?.id, device.id)
})

test('a device seen again is marked, but not rewritten on every frame', () => {
  const path = join(dir, 'touch.json')
  const store = DeviceStore.open(path)
  const { device } = store.add('手机', 'app', 1000)
  const before = readFileSync(path, 'utf8')
  store.touch(device.id, 1000 + 10_000)
  assert.equal(readFileSync(path, 'utf8'), before, 'a recent touch stays in memory')
  store.touch(device.id, 1000 + 120_000)
  assert.ok(JSON.parse(readFileSync(path, 'utf8'))[0].lastSeenAt >= 1000 + 120_000)
})

test('a devices file that is not a devices file is refused loudly, not read as empty', () => {
  const path = join(dir, 'broken.json')
  writeFileSync(path, '{"not":"a list"}', 'utf8')
  assert.throws(() => DeviceStore.open(path), /not a devices file/)
  writeFileSync(path, '[{"id":1}]', 'utf8')
  assert.throws(() => DeviceStore.open(path), /not a device/)
})
