#!/usr/bin/env node
// E1 scoring: put the restart and migrate answers side by side, then count.
//
//   node experiments/e1-score.mjs
//
// The score is a human call on purpose. What counts as "the same answer" is a semantic question,
// and a token-overlap script would happily call "I live in D:\old" and "I live in D:\new" different
// when the move itself is what changed the path. The script only lays them out and flags the
// obvious keyword matches; a person marks the final 4/4.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'out')

function load(name) {
  try {
    return JSON.parse(readFileSync(join(out, name), 'utf8'))
  } catch {
    return undefined
  }
}

const restart = load('e1-restart-full.json')
const migrate = load('e1-migrate-full.json')

if (!restart || !migrate) {
  console.error('need out/e1-restart-full.json and out/e1-migrate-full.json first')
  process.exit(1)
}

const byId = new Map(migrate.answers.map((answer) => [answer.id, answer]))
const rows = restart.answers.map((answer) => {
  const other = byId.get(answer.id)
  return {
    id: answer.id,
    class: answer.class,
    question: answer.question,
    restart: answer.answer,
    migrate: other?.answer ?? '(missing)',
  }
})

for (const row of rows) {
  console.log(`\n### ${row.id} [${row.class}] ${row.question}`)
  console.log(`  restart: ${row.restart.slice(0, 160)}`)
  console.log(`  migrate: ${row.migrate.slice(0, 160)}`)
}

writeFileSync(join(out, 'e1-side-by-side.json'), JSON.stringify({ version: 0, rows }, null, 2))
console.log(`\nwrote ${join(out, 'e1-side-by-side.json')} — mark the consistent ones, then update e1-result.json`)
