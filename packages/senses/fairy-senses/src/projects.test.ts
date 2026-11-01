import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseLog, readProject, subjects } from './projects.js'

test('subjects come from where a commit lands and what kind of files it touches', () => {
  assert.deepEqual(subjects(['packages/a/src/x.test.ts', 'docs/memory.md', 'README.md']), ['packages', '测试', 'TypeScript', 'docs', '文档'])
})

test('reads git log output into items she can come across', () => {
  const output = '\u001eabc\u001f1793520000\u001ffix: the lock\u001fA longer body.\nSecond line.\u001f\nsrc/lock.ts\nsrc/lock.test.ts\n\n\u001edef\u001f1793500000\u001fdocs\u001f\u001f\nREADME.md\n'
  assert.deepEqual(parseLog(output, 'fairy'), [
    {
      id: 'fairy:abc',
      title: 'fairy：fix: the lock',
      text: 'A longer body. Second line.\n改动：src/lock.ts、src/lock.test.ts',
      tags: ['fairy', 'src', 'TypeScript', '测试'],
      at: 1793520000000,
      source: 'fairy',
    },
    { id: 'fairy:def', title: 'fairy：docs', text: '改动：README.md', tags: ['fairy', '文档'], at: 1793500000000, source: 'fairy' },
  ])
})

test('reads a real repository, this one', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
  const items = await readProject(root, 3)
  assert.equal(items.length, 3)
  assert.ok(items.every((item) => item.id.startsWith('fairy-framework:') && item.title.length > 0))
})
