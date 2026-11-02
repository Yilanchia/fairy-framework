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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = 'fairy'
const dshBin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const bundleDir = join(root, 'packages', 'bundle', 'fairy-bundle')

/**
 * Her own `.env` (gitignored), for the child process only: nothing is written to the system
 * environment. Variables already set in the environment win; empty values are skipped, so the
 * blank `DEEPSEEK_API_KEY=` from `.env.example` does not hide a key set elsewhere.
 */
function ownEnv() {
  const file = join(root, '.env')
  if (!existsSync(file)) return {}
  return Object.fromEntries(Object.entries(parseEnv(readFileSync(file, 'utf8'))).filter(([, value]) => value !== ''))
}

function place(home, lifePath = join(home, 'fairy.life.jsonl')) {
  if (/[^\x00-\x7f]/u.test(home)) {
    // pnpm fails with EPERM under non-ASCII paths on Windows; see docs/decisions.md.
    throw new Error(`DSH home must be an ASCII path, got ${home}`)
  }
  // A conversation started from a device needs a directory to own before it exists.
  const workspace = join(home, 'workspace')
  try {
    mkdirSync(workspace, { recursive: true })
  } catch {
    // It is created again when her first device conversation starts; the failure is not fatal.
  }
  return {
    home,
    lifePath,
    env: {
      ...ownEnv(),
      ...process.env,
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(home, 'agents'),
      // Her conversations are private: no OpenTelemetry feedback upload unless asked for.
      DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE ?? 'DISABLED',
      FAIRY_DOCUMENTS: join(home, 'documents'),
      FAIRY_LIFE_PATH: lifePath,
      // What her hands did, one JSON line per tool call. Next to her home, never in the repo.
      FAIRY_AUDIT_PATH: join(home, 'audit.jsonl'),
      // The devices she may talk to (tokens kept as hashes), and where device conversations live.
      FAIRY_DEVICES_PATH: join(home, 'devices.json'),
      FAIRY_SESSION_CWD: workspace,
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
    if (!existsSync(at.lifePath)) {
      throw new Error(`no life at ${at.lifePath}: she has not been born yet. Run \`pnpm fairy\` first; that first start is her birth.`)
    }
    const { formatInspection, inspect, readLife } = await import('../packages/self/fairy-isla/dist/index.js')
    const query = process.argv.slice(3).join(' ').trim() || undefined
    console.log(formatInspection(inspect(readLife(at.lifePath), query), query))
  } else if (command === 'pair') {
    // The code rotates in the running host; read the latest instead of making the owner reboot.
    const file = join(at.home, 'pairing-code')
    if (!existsSync(file)) throw new Error('no pairing code: she is not running. Start her first (`pnpm fairy`), or check `journalctl -u fairy`.')
    const [code, expires] = readFileSync(file, 'utf8').trim().split(/\s+/u)
    const until = Number(expires)
    const publicUrl = (process.env.FAIRY_PUBLIC_URL ?? ownEnv().FAIRY_PUBLIC_URL ?? 'http://127.0.0.1:3090').replace(/\/$/u, '')
    if (until === 0) {
      console.log(`pairing code ${code} (fixed; it does not change)`)
    } else {
      const minutes = Math.round((until - Date.now()) / 60_000)
      if (!Number.isFinite(minutes) || minutes <= 0) {
        throw new Error('that code just expired; the next one arrives within a few minutes (or restart her)')
      }
      console.log(`pairing code ${code}, valid for another ${minutes} minute(s)`)
    }
    console.log(`open ${publicUrl}/fairy/app/ and type it in`)
  } else if (command === 'devices') {
    const { DeviceStore } = await import('../packages/link/fairy-link/dist/index.js')
    const store = DeviceStore.open(join(at.home, 'devices.json'))
    const rows = store.list()
    if (rows.length === 0) {
      console.log('no devices paired yet')
    }
    for (const device of rows) {
      const seen = device.lastSeenAt ? new Date(device.lastSeenAt).toISOString().slice(0, 16).replace('T', ' ') : '-'
      console.log(`${device.id}  ${device.kind.padEnd(4)}  ${device.name}  (paired ${new Date(device.createdAt).toISOString().slice(0, 10)}, last seen ${seen})`)
    }
    if (rows.length > 0) console.log('\n`node scripts/fairy.mjs revoke <id>` forgets one; she stops honouring it at once.')
  } else if (command === 'revoke') {
    const id = process.argv[3]
    if (!id) throw new Error('which device? `node scripts/fairy.mjs devices` lists them')
    const { DeviceStore } = await import('../packages/link/fairy-link/dist/index.js')
    const store = DeviceStore.open(join(at.home, 'devices.json'))
    if (!store.revoke(id)) throw new Error(`no paired device with id ${id}`)
    console.log(`revoked ${id}: that token stops working now, without restarting her`)
  } else if (command === 'doctor') {
    // Read-only: no lock, no writes, safe while she is running. Answers "is she okay" in one look.
    const { formatHealth, healthReport, readLife } = await import('../packages/self/fairy-isla/dist/index.js')
    let events
    let tornTail = false
    if (existsSync(at.lifePath)) {
      const lines = readFileSync(at.lifePath, 'utf8').split('\n').filter((line) => line.trim())
      const parsed = readLife(at.lifePath)
      events = parsed.length
      tornTail = parsed.length < lines.length
    }
    const lockPath = `${at.lifePath}.lock`
    const holder = existsSync(lockPath) ? Number(readFileSync(lockPath, 'utf8').trim()) : undefined
    let held = false
    if (holder && Number.isInteger(holder)) {
      try {
        process.kill(holder, 0)
        held = true
      } catch (error) {
        held = error.code === 'EPERM'
      }
    }
    const backupDir = join(at.home, 'backups')
    let newest = undefined
    if (existsSync(backupDir)) {
      for (const file of readdirSync(backupDir)) {
        const at2 = statSync(join(backupDir, file)).mtimeMs
        if (newest === undefined || at2 > newest) newest = at2
      }
    }
    const devicesPath = join(at.home, 'devices.json')
    let devices = 0
    if (existsSync(devicesPath)) {
      try {
        devices = JSON.parse(readFileSync(devicesPath, 'utf8')).length
      } catch {
        devices = 0
      }
    }
    const port = Number(process.env.FAIRY_PORT ?? '3090')
    const portOpen = await new Promise((resolvePromise) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.setTimeout(1500)
      socket.once('connect', () => {
        socket.destroy()
        resolvePromise(true)
      })
      socket.once('timeout', () => {
        socket.destroy()
        resolvePromise(false)
      })
      socket.once('error', () => resolvePromise(false))
    })
    console.log(
      formatHealth(
        healthReport({
          lifePath: at.lifePath,
          events,
          tornTail,
          lockHolder: holder,
          lockHeld: held,
          backupAgeMs: newest === undefined ? undefined : Date.now() - newest,
          vectors: existsSync(join(at.home, 'memory-vectors.jsonl')),
          devices,
          port,
          portOpen,
        }),
      ),
    )
  } else {
    throw new Error(`unknown command ${command}`)
  }
} catch (error) {
  console.error(`fairy: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
