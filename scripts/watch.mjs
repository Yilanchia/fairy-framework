#!/usr/bin/env node
// Fairy Watch's own launcher. Watch is a separate member of the family: its own home, its own
// profile, its own bundle, its own port. It never reads or writes the butler's `.fairy-home`.
// The two share packages and conventions, not data or a process.
//
//   node scripts/watch.mjs setup   create the isolated `watch` profile and install the bundle
//   node scripts/watch.mjs dump    print the composed plugin tree
//   node scripts/watch.mjs web     serve the Web UI on Watch's own port (default 3091)
//   node scripts/watch.mjs smoke   boot once in a throwaway home and check the plugin loads
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = 'watch'
const dshBin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const bundleDir = join(root, 'packages', 'watch', 'fairy-watch-host')

/** The project's `.env` (gitignored), for this child process only. */
function ownEnv() {
  const file = join(root, '.env')
  if (!existsSync(file)) return {}
  return Object.fromEntries(Object.entries(parseEnv(readFileSync(file, 'utf8'))).filter(([, value]) => value !== ''))
}

function place(home) {
  if (/[^\x00-\x7f]/u.test(home)) {
    throw new Error(`Watch home must be an ASCII path, got ${home}`)
  }
  return {
    home,
    env: {
      ...ownEnv(),
      ...process.env,
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(home, 'agents'),
      DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE ?? 'DISABLED',
      WATCH_AUDIT_PATH: join(home, 'audit.jsonl'),
      WATCH_EVIDENCE_PATH: join(home, 'watch.jsonl'),
      WATCH_DB_PATH: join(home, 'watch.db'),
      WATCH_REPORT_DIR: join(home, 'watch-reports'),
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
  if (!bundles.includes('@fairy/watch-host')) {
    const run = start(at, ['plugin', '--profile', profile, 'add', `link:${bundleDir}`], { capture: quiet })
    if ((await run.done) !== 0) throw new Error(`installing @fairy/watch-host failed:\n${run.output}`)
  }
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
  const at = place(mkdtempSync(join(tmpdir(), 'watch-smoke-')))
  try {
    await setup(at, { quiet: true })
    const run = start(at, ['--profile', profile, '--no-open', '--port', '0'], { capture: true })
    try {
      await waitFor('the Web server', () => /http:\/\/127\.0\.0\.1:\d+\//u.test(run.output), run, 120_000)
      const problems = run.output.split('\n').filter((line) => /@fairy\/|fairy-(guard|watch)/u.test(line))
      if (problems.length > 0) throw new Error(`Watch plugins reported problems:\n${problems.join('\n')}`)
      console.log(`watch: smoke passed — the Web server bound and the watch plugin loaded in ${at.home}`)
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
  const at = place(process.env.WATCH_HOME ?? join(root, '.watch-home'))
  if (command === 'setup') {
    await setup(at)
    console.log(`watch: profile ready at ${join(at.home, 'profiles', profile)}`)
  } else if (command === 'dump') {
    process.exitCode = await start(at, ['--profile', profile, '--dump-config']).done
  } else if (command === 'web') {
    await setup(at)
    console.log(`watch: home is ${at.home}`)
    const port = process.env.WATCH_PORT ?? '3091'
    process.exitCode = await start(at, ['--profile', profile, '--port', port, ...process.argv.slice(3)]).done
  } else if (command === 'smoke') {
    await smoke()
  } else {
    throw new Error(`unknown command ${command}`)
  }
} catch (error) {
  console.error(`watch: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
