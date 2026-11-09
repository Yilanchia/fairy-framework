import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyProposal } from './apply.js'
import { WatchStore } from './store.js'
import type { FixProposal } from './types.js'

const at = 1_800_000_000_000

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fairy-watch-apply-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  const file = join(dir, 'sshd_config')
  writeFileSync(file, ['# sshd', 'PasswordAuthentication yes', 'PermitRootLogin yes'].join('\n'), 'utf8')
  const cleanup = () => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { dir, store, file, cleanup }
}

function proposal(kind: string, before: string, after: string): FixProposal {
  return {
    type: 'proposal',
    id: 'fix-1',
    at,
    findingId: 'find-1',
    key: `ssh:${kind}`,
    kind,
    title: `问题 ${kind}`,
    changes: [{ file: 'sshd_config', before, after }],
    risk: 'medium',
    rollback: 'cp backup back',
    verify: 'sshd -t',
    executable: true,
  }
}

test('applying a plan edits the exact line, keeps a backup, and records what happened', () => {
  const { dir, store, file, cleanup } = setup()
  try {
    const message = applyProposal(store, proposal('ssh_password_authentication', 'PasswordAuthentication yes', 'PasswordAuthentication no'), {
      sshdConfig: file,
      now: at,
    })
    assert.match(message, /已应用/)
    assert.match(readFileSync(file, 'utf8'), /PasswordAuthentication no/)
    assert.doesNotMatch(readFileSync(file, 'utf8'), /PasswordAuthentication yes/)

    const backup = join(dir, `sshd_config.fairy-backup-${at}`)
    assert.equal(existsSync(backup), true)
    assert.match(readFileSync(backup, 'utf8'), /PasswordAuthentication yes/)

    const log = readFileSync(join(dir, 'watch.jsonl'), 'utf8')
    assert.match(log, /"type":"action"/)
    assert.match(log, /"outcome":"applied"/)
  } finally {
    cleanup()
  }
})

test('a second apply does nothing when the line has already changed', () => {
  const { store, file, cleanup } = setup()
  try {
    const plan = proposal('ssh_password_authentication', 'PasswordAuthentication yes', 'PasswordAuthentication no')
    applyProposal(store, plan, { sshdConfig: file, now: at })
    const second = applyProposal(store, plan, { sshdConfig: file, now: at + 1 })
    assert.match(second, /不执行/)
    assert.match(readFileSync(file, 'utf8'), /PasswordAuthentication no/)
  } finally {
    cleanup()
  }
})

test('kinds without a mechanical edit are refused', () => {
  const { store, file, cleanup } = setup()
  try {
    const message = applyProposal(store, { ...proposal('new_listen_port', 'x', 'y'), changes: [] }, { sshdConfig: file, now: at })
    assert.match(message, /不执行/)
  } finally {
    cleanup()
  }
})

test('a missing file is refused, not guessed', () => {
  const { store, cleanup } = setup()
  try {
    const message = applyProposal(store, proposal('ssh_password_authentication', 'PasswordAuthentication yes', 'PasswordAuthentication no'), {
      sshdConfig: join(tmpdir(), 'definitely-not-here-sshd_config'),
      now: at,
    })
    assert.match(message, /不执行/)
  } finally {
    cleanup()
  }
})
