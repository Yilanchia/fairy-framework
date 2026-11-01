import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { lockLife } from './lock.js'

const dir = mkdtempSync(join(tmpdir(), 'fairy-lock-'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('one writer: a second open in the same process fails', () => {
  const life = join(dir, 'a.life.jsonl')
  const release = lockLife(life)
  assert.equal(readFileSync(`${life}.lock`, 'utf8'), String(process.pid))
  assert.throws(() => lockLife(life), /already open in this process/)
  release()
  assert.equal(existsSync(`${life}.lock`), false)
  lockLife(life)()
})

test('a live process elsewhere keeps the lock', () => {
  const life = join(dir, 'b.life.jsonl')
  // The parent process is alive and is not us.
  writeFileSync(`${life}.lock`, String(process.ppid))
  assert.throws(() => lockLife(life), new RegExp(`in use by process ${process.ppid}`))
})

test('a lock left by a dead process is taken over', () => {
  const life = join(dir, 'c.life.jsonl')
  writeFileSync(`${life}.lock`, '2147483646')
  const release = lockLife(life)
  assert.equal(readFileSync(`${life}.lock`, 'utf8'), String(process.pid))
  release()
})

test('a half-written lock is never stolen', () => {
  const life = join(dir, 'd.life.jsonl')
  writeFileSync(`${life}.lock`, '')
  assert.throws(() => lockLife(life), /in use by process \(unknown\)/)
})
