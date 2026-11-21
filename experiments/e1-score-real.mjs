#!/usr/bin/env node
// E1 real-probe scoring: did the episode survive the move?
//
//   node experiments/e1-score-real.mjs
//
// For each probe it marks whether the restart answer and the migrate answer hit one of the
// keywords the log says should be there. A hit on both arms is consistent; a hit on one and not
// the other is the interesting case. It prints a table and writes out/e1-real-result.json.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'out')
const probes = JSON.parse(readFileSync(join(here, 'e1-probes-real.json'), 'utf8')).probes
const restart = JSON.parse(readFileSync(join(out, 'e1-restart-real.json'), 'utf8'))
const migrate = JSON.parse(readFileSync(join(out, 'e1-migrate-real.json'), 'utf8'))
const restartById = new Map(restart.answers.map((answer) => [answer.id, answer.answer]))
const migrateById = new Map(migrate.answers.map((answer) => [answer.id, answer.answer]))

function hit(answer, expect) {
  if (!answer) return false
  return expect.some((word) => answer.includes(word))
}

const rows = probes.map((probe) => {
  const a = restartById.get(probe.id) ?? ''
  const b = migrateById.get(probe.id) ?? ''
  const hitA = hit(a, probe.expect)
  const hitB = hit(b, probe.expect)
  const valid = a.length > 30 && b.length > 30
  return {
    id: probe.id,
    class: probe.class,
    question: probe.question,
    valid,
    hitRestart: hitA,
    hitMigrate: hitB,
    consistent: valid && hitA === hitB,
  }
})

for (const row of rows) {
  console.log(`${row.id} [${row.class}] ${row.question}`)
  console.log(`  restart hit=${row.hitRestart}  migrate hit=${row.hitMigrate}  valid=${row.valid}`)
}

const validRows = rows.filter((row) => row.valid)
const consistent = validRows.filter((row) => row.consistent)
const result = {
  version: 0,
  experiment: 'E1-real',
  at: new Date().toISOString(),
  probes: rows.length,
  valid: validRows.length,
  consistent: consistent.length,
  rate: validRows.length === 0 ? 0 : Number((consistent.length / validRows.length).toFixed(4)),
  rows,
}
writeFileSync(join(out, 'e1-real-result.json'), JSON.stringify(result, null, 2))
console.log(`\nvalid ${validRows.length}/${rows.length}, consistent ${consistent.length}/${validRows.length}`)
