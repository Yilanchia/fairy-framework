#!/usr/bin/env node
// Fairy's launcher. It is the only thing that knows where her DSH home and life live, and it sets
// them for the child process only: the user's own `dsh`, DSH Desktop, ~/.dsh and ~/.agents are
// never read or written.
//
//   node scripts/fairy.mjs setup   create the isolated `fairy` profile and install the bundle
//   node scripts/fairy.mjs dump    print the composed plugin tree
//   node scripts/fairy.mjs web     serve the Web UI on Fairy's own port (default 3090)
//   node scripts/fairy.mjs smoke   boot once in a throwaway home and check she comes alive
//   node scripts/fairy.mjs memory [query]   what she keeps, and what a search finds (read-only)
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = 'fairy'
const dshBin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const bundleDir = join(root, 'packages', 'bundle', 'fairy-bundle')

function place(home, lifePath = join(home, 'fairy.life.jsonl')) {
  if (/[^\x00-\x7f]/u.test(home)) {
    // pnpm fails with EPERM under non-ASCII paths on Windows; see docs/decisions.md.
    throw new Error(`DSH home must be an ASCII path, got ${home}`)
  }
  return {
    home,
    lifePath,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(home, 'agents'),
      // Her conversations are private: no OpenTelemetry feedback upload unless asked for.
      DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE ?? 'DISABLED',
      FAIRY_DOCUMENTS: join(home, 'documents'),
      FAIRY_LIFE_PATH: lifePath,
    },
  }
}

function start(at, args, { capture = false } = {}) {
  const child = spawn(process.execPath, [dshBin, ...args], {
    env: at.env,
    cwd: root,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  const run = { child, output: '', exited: false }
  if (capture) {
    child.stdout.on('data', (chunk) => (run.output += chunk))
    child.stderr.on('data', (chunk) => (run.output += chunk))
  }
  run.done = new Promise((resolvePromise, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => {
      run.exited = true
      resolvePromise(code ?? 1)
    })
  })
  return run
}

async function setup(at, { quiet = false } = {}) {
  const manifest = join(at.home, 'profiles', profile, 'package.json')
  if (!existsSync(manifest)) {
    const run = start(at, ['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { capture: true })
    if ((await run.done) !== 0) throw new Error(`creating the profile failed:\n${run.output}`)
  }
  const bundles = JSON.parse(readFileSync(manifest, 'utf8')).dsh?.profile?.bundles ?? []
  if (!bundles.includes('@fairy/bundle')) {
    const run = start(at, ['plugin', '--profile', profile, 'add', `link:${bundleDir}`], { capture: quiet })
    if ((await run.done) !== 0) throw new Error(`installing @fairy/bundle failed:\n${run.output}`)
  }
}

function born(lifePath) {
  if (!existsSync(lifePath)) return undefined
  const first = readFileSync(lifePath, 'utf8').split('\n', 1)[0]
  if (!first) return undefined
  const event = JSON.parse(first)
  return event.kind === 'born' ? event.payload.genome.name : undefined
}

async function waitFor(what, read, run, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value) return value
    if (run.exited) throw new Error(`dsh exited before ${what}:\n${run.output}`)
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${run.output}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
}

async function smoke() {
  // A throwaway home: the smoke test must never give birth to the real her.
  const at = place(mkdtempSync(join(tmpdir(), 'fairy-smoke-')))
  try {
    await setup(at, { quiet: true })
    const run = start(at, ['--profile', profile, '--no-open', '--port', '0'], { capture: true })
    try {
      await waitFor('the Web server', () => /http:\/\/127\.0\.0\.1:\d+\//u.test(run.output), run, 120_000)
      const name = await waitFor('her birth', () => born(at.lifePath), run, 30_000)
      // Plugin failures are the only lines DeepSeek Harness prints that name Fairy's packages.
      const problems = run.output.split('\n').filter((line) => /@fairy\/|fairy-(self|guard|senses|presence|hands)/u.test(line))
      if (problems.length > 0) throw new Error(`Fairy plugins reported problems:\n${problems.join('\n')}`)
      console.log(`fairy: smoke passed — the Web server bound and ${name} was born in ${at.lifePath}`)
    } finally {
      run.child.kill()
      await run.done
    }
  } finally {
    rmSync(at.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

const command = process.argv[2] ?? 'web'
try {
  const at = place(process.env.FAIRY_HOME ?? join(root, '.fairy-home'), process.env.FAIRY_LIFE_PATH)
  if (command === 'setup') {
    await setup(at)
    console.log(`fairy: profile ready at ${join(at.home, 'profiles', profile)}`)
  } else if (command === 'dump') {
    process.exitCode = await start(at, ['--profile', profile, '--dump-config']).done
  } else if (command === 'web') {
    await setup(at)
    if (!born(at.lifePath)) {
      console.log('fairy: first start, so this is her birth. Her genome is packages/self/fairy-isla/src/genome.ts.')
    }
    console.log(`fairy: her life is ${at.lifePath}`)
    const port = process.env.FAIRY_PORT ?? '3090'
    process.exitCode = await start(at, ['--profile', profile, '--port', port, ...process.argv.slice(3)]).done
  } else if (command === 'smoke') {
    await smoke()
  } else if (command === 'memory') {
    // Read-only: no lock, no writes, safe while she is running. Pass a backup path in
    // FAIRY_LIFE_PATH to look at an old copy.
    if (!existsSync(at.lifePath)) throw new Error(`no life at ${at.lifePath}: she has not been born yet`)
    const { formatInspection, inspect, readLife } = await import('../packages/self/fairy-isla/dist/index.js')
    const query = process.argv.slice(3).join(' ').trim() || undefined
    console.log(formatInspection(inspect(readLife(at.lifePath), query), query))
  } else {
    throw new Error(`unknown command ${command}`)
  }
} catch (error) {
  console.error(`fairy: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
