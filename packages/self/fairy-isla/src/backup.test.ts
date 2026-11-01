import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { backupLife } from './backup.js'

const dir = mkdtempSync(join(tmpdir(), 'fairy-backup-'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('one copy a day, the oldest beyond the limit removed, nothing else touched', () => {
  const life = join(dir, 'fairy.life.jsonl')
  const backups = join(dir, 'backups')
  assert.equal(backupLife(life, backups, 3), undefined, 'no life yet, nothing to copy')

  writeFileSync(life, '{"seq":1}\n')
  writeFileSync(join(dir, 'unrelated.bak'), 'keep me')
  for (let day = 1; day <= 5; day++) {
    const written = backupLife(life, backups, 3, new Date(Date.UTC(2026, 10, day, 12)))
    assert.ok(written?.endsWith(`fairy.life.jsonl.2026-11-0${day}.bak`))
  }
  // A second run on the same day does not overwrite the morning's copy.
  writeFileSync(life, '{"seq":1}\n{"seq":2}\n')
  backupLife(life, backups, 3, new Date(Date.UTC(2026, 10, 5, 20)))
  assert.equal(readFileSync(join(backups, 'fairy.life.jsonl.2026-11-05.bak'), 'utf8'), '{"seq":1}\n')

  writeFileSync(join(backups, 'notes.txt'), 'mine')
  backupLife(life, backups, 3, new Date(Date.UTC(2026, 10, 6, 12)))
  assert.deepEqual(readdirSync(backups).sort(), [
    'fairy.life.jsonl.2026-11-04.bak',
    'fairy.life.jsonl.2026-11-05.bak',
    'fairy.life.jsonl.2026-11-06.bak',
    'notes.txt',
  ])
  assert.equal(readFileSync(join(dir, 'unrelated.bak'), 'utf8'), 'keep me')
})

test('keep 0 turns backups off', () => {
  const life = join(dir, 'off.life.jsonl')
  writeFileSync(life, '{}\n')
  assert.equal(backupLife(life, join(dir, 'off'), 0), undefined)
  assert.throws(() => readdirSync(join(dir, 'off')))
})
