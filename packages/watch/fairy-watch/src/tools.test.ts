import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchStore } from './store.js'
import { proposeFix, takeBaseline, takeDiff, writeReport, type WatchConfig } from './tools.js'
import type { Finding } from './types.js'

const at = 1_800_000_000_000

function setup(initialOutput: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fairy-watch-tools-'))
  const store = new WatchStore(join(dir, 'watch.jsonl'), join(dir, 'watch.db'))
  let output = initialOutput
  const config: WatchConfig = {
    evidencePath: join(dir, 'watch.jsonl'),
    databasePath: join(dir, 'watch.db'),
    reportDir: join(dir, 'reports'),
    ports: true,
    ssh: false,
    backup: false,
    backupPaths: [],
    backupStaleHours: 36,
  }
  const context = {
    store,
    config,
    platform: 'linux' as const,
    now: () => at,
    runner: (command: string) => (command === 'ss' ? { exit: 0, stdout: output, stderr: '' } : { exit: 127, stdout: '', stderr: '' }),
  }
  return {
    context,
    setOutput: (next: string) => {
      output = next
    },
    cleanup: () => {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const PORTS = [
  'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
  'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))',
].join('\n')

const PORTS_WITH_NEW = [PORTS, 'LISTEN 0 128 *:3306 *:* users:(("mysqld",pid=2,fd=20))'].join('\n')

test('baseline, diff, and no repeat of the same finding', () => {
  const { context, setOutput, cleanup } = setup(PORTS)
  try {
    const baseline = takeBaseline(context)
    assert.match(baseline, /已记录基线/)
    assert.match(baseline, /监听端口 1 个/)

    setOutput(PORTS_WITH_NEW)
    const diff = takeDiff(context)
    assert.match(diff, /新发现 1 条/)
    assert.match(diff, /tcp:3306/)

    const again = takeDiff(context)
    assert.match(again, /没有新发现/)
  } finally {
    cleanup()
  }
})

test('the report lands as Markdown with the finding in it', () => {
  const { context, setOutput, cleanup } = setup(PORTS)
  try {
    takeBaseline(context)
    setOutput(PORTS_WITH_NEW)
    takeDiff(context)
    const message = writeReport(context)
    assert.match(message, /日报已写到/)

    const path = message.match(/日报已写到 (.+?)（/)?.[1]
    assert.ok(path)
    assert.equal(existsSync(path), true)
    const text = readFileSync(path, 'utf8')
    assert.match(text, /Fairy Watch 日报/)
    assert.match(text, /新开的监听端口/)
    assert.match(text, /3306/)
  } finally {
    cleanup()
  }
})

test('a proposal is stored and reads as a plan, and says it will not act', () => {
  const { context, cleanup } = setup(PORTS)
  try {
    const finding: Finding = {
      type: 'finding',
      id: 'find-ssh',
      at,
      kind: 'ssh_password_authentication',
      severity: 'high',
      key: 'ssh:passwordauthentication',
      title: 'SSH 允许密码登录',
      detail: 'PasswordAuthentication yes',
      epistemic: 'observed',
      observationId: 'obs-ssh',
      status: 'candidate',
    }
    context.store.append(finding)
    const text = proposeFix(context, { key: 'ssh:passwordauthentication' })
    assert.match(text, /修复提案/)
    assert.match(text, /PasswordAuthentication yes/)
    assert.match(text, /不能/)
    assert.match(text, /只提案，不动系统/)

    const stored = context.store.proposalFor(finding.id)
    assert.ok(stored)
    assert.equal(stored.executable, false)
  } finally {
    cleanup()
  }
})
