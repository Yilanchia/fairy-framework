import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { listenFacts, parseAuthorizedKeys, parseSsListen, parseSshdConfig, parseWindowsListen } from './parse.js'

test('ss -ltnp output becomes one socket per LISTEN line', () => {
  const output = [
    'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
    'LISTEN 0      128    0.0.0.0:22         0.0.0.0:*         users:(("sshd",pid=123,fd=3))',
    'LISTEN 0      511    [::]:80            [::]:*            users:(("nginx",pid=456,fd=6))',
    'LISTEN 0      128    *:3306             *:*               users:(("mysqld",pid=789,fd=20))',
  ].join('\n')

  const sockets = parseSsListen(output)
  assert.deepEqual(
    sockets.map((socket) => socket.port),
    [22, 80, 3306],
  )
  assert.equal(sockets[0]!.process, 'sshd')
  assert.equal(sockets[1]!.address, '[::]')
})

test('a port listened on two addresses is one fact with both addresses', () => {
  const sockets = parseSsListen(
    ['LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))', 'LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=1,fd=3))'].join('\n'),
  )
  const facts = listenFacts(sockets)
  assert.equal(facts.length, 1)
  assert.match(facts[0]!.value, /0\.0\.0\.0:22/)
  assert.match(facts[0]!.value, /\[::\]:22/)
})

test('sshd_config takes the first effective value and ignores comments and later overrides', () => {
  const facts = parseSshdConfig(
    ['# PasswordAuthentication no', 'PasswordAuthentication yes', 'PermitRootLogin no', 'PasswordAuthentication no'].join('\n'),
  )
  const byKey = Object.fromEntries(facts.map((fact) => [fact.key, fact.value]))
  assert.equal(byKey['ssh:passwordauthentication'], 'yes')
  assert.equal(byKey['ssh:permitrootlogin'], 'no')
})

test('authorized_keys keeps a fingerprint, never the key material', () => {
  const text = ['# a comment', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample owner@example.com', '', 'ssh-rsa AAAAB3NzaC1yc2EExample'].join('\n')
  const facts = parseAuthorizedKeys(text)
  const count = facts.find((fact) => fact.key === 'ssh:authorized_keys:count')
  assert.equal(count?.value, '2')
  const keys = facts.filter((fact) => fact.kind === 'ssh_authorized_key')
  assert.equal(keys.length, 2)
  for (const key of keys) {
    assert.equal(key.value === 'ssh-ed25519' || key.value === 'ssh-rsa', true)
    assert.doesNotMatch(key.key, /AAA/)
  }
})

test('Get-NetTCPConnection JSON is understood, and garbage is not a crash', () => {
  const rows = parseWindowsListen('[{"LocalAddress":"0.0.0.0","LocalPort":135,"OwningProcess":4}]')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.port, 135)
  assert.deepEqual(parseWindowsListen('not json'), [])
})
