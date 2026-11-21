#!/usr/bin/env node
// E1: ask the same probes before and after a move, and compare.
//
//   node experiments/e1.mjs --base-url http://127.0.0.1:3090 --out e1-restart.json
//
// The only missing piece is ask(): how to send one question to a running Fairy and get her
// answer. Until that is wired, this script stops early and says so, rather than pretending.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const probes = JSON.parse(readFileSync(join(here, 'e1-probes.json'), 'utf8')).probes

/**
 * Ask Fairy one question and return her answer as plain text.
 *
 * Two candidate transports:
 *   1. Fairy's own Web UI backend (confirm the route in `scripts/fairy.mjs` and DSH docs);
 *   2. DSH headless, e.g. `dsh -p "<question>" --profile fairy`, read stdout.
 *
 * Whichever is used, pin the model version and sampling parameters in the output file.
 */
async function ask(question, baseUrl) {
  throw new Error(
    `ask() is not wired yet (baseUrl=${baseUrl}). Wire it before running E1; question was: ${question}`,
  )
}

function parseArgs(argv) {
  const args = { baseUrl: 'http://127.0.0.1:3090', out: 'e1-run.json', model: 'unset' }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--base-url') args.baseUrl = argv[++index]
    else if (argv[index] === '--out') args.out = argv[++index]
    else if (argv[index] === '--model') args.model = argv[++index]
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const answers = []
  for (const probe of probes) {
    const answer = await ask(probe.question, args.baseUrl)
    answers.push({ ...probe, answer })
    console.log(`${probe.id}: ${answer.slice(0, 80)}`)
  }
  mkdirSync(join(here, 'out'), { recursive: true })
  const file = join(here, 'out', args.out)
  writeFileSync(
    file,
    JSON.stringify(
      { version: 0, at: new Date().toISOString(), model: args.model, probes: probes.length, answers },
      null,
      2,
    ),
  )
  console.log(`wrote ${file}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
