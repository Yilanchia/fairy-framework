import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import UserQuestionService, { type AskUserQuestionAnswer, type AskUserQuestionRequest as AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions'
import * as guard from './index.js'
import type { AuditRecord } from './index.js'

const dir = mkdtempSync(join(tmpdir(), 'fairy-guard-'))
after(() => rmSync(dir, { recursive: true, force: true }))

/** A host with the real tool runtime and question service, a fake shell, and a fake owner. */
async function host(
  answer: ((request: AskUserQuestionRequestEvent) => AskUserQuestionAnswer) | 'nobody',
  device?: { selected: string[]; asked: string[] },
) {
  const auditPath = join(dir, `audit-${Math.random().toString(36).slice(2)}.jsonl`)
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {}).await()
  await ctx.plugin(ToolRuntime, {}).await()
  await ctx.plugin(UserQuestionService).await()
  const asked: AskUserQuestionRequestEvent[] = []
  if (answer !== 'nobody') {
    ctx.on('user-questions/request', async (request) => {
      asked.push(request)
      return answer(request)
    })
  }
  if (device) {
    ctx.provide('fairyLink', {
      async confirm(question: { question: string }) {
        device.asked.push(question.question)
        return device.selected.length > 0 ? { selected: device.selected } : undefined
      },
    })
  }
  const ran: string[] = []
  ctx.tools.register(
    defineTool({
      name: 'pwsh',
      description: 'test shell',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute({ command }) {
        ran.push(command)
        return 'done'
      },
    }),
  )
  await ctx.plugin(guard, { auditPath, ask: ['destructive', 'outward', 'money'], askTimeoutMs: 5000 }).await()
  const run = (command: string) =>
    ctx.tools.execute({
      callId: `call-${ran.length}-${asked.length}` as ToolExecutionInput['callId'],
      name: 'pwsh',
      arguments: { command },
      signal: new AbortController().signal,
    })
  const audit = () =>
    readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AuditRecord)
  return { run, ran, asked, audit }
}

const say = (label: string) => (): AskUserQuestionAnswer => ({ answers: [{ id: 'fairy-guard', selected: [label] }] })

test('ordinary work runs without a question and is logged', async () => {
  const { run, ran, asked, audit } = await host(say('不允许'))
  const result = await run('git status')
  assert.equal(result.isError, false)
  assert.deepEqual(ran, ['git status'])
  assert.equal(asked.length, 0)
  assert.deepEqual(
    audit().map(({ tool, tier, decision, outcome }) => ({ tool, tier, decision, outcome })),
    [{ tool: 'pwsh', tier: 'routine', decision: 'allowed', outcome: 'ok' }],
  )
})

test('a delete waits for the owner, and runs once they say yes', async () => {
  const { run, ran, asked, audit } = await host(say('允许这一次'))
  const result = await run('Remove-Item -Recurse old')
  assert.equal(result.isError, false)
  assert.deepEqual(ran, ['Remove-Item -Recurse old'])
  assert.equal(asked.length, 1)
  assert.match(asked[0]!.questions[0]!.question, /删除或不可撤销：删除文件或文件夹/)
  assert.match(asked[0]!.questions[0]!.detail ?? '', /Remove-Item -Recurse old/)
  assert.equal(audit()[0]?.decision, 'approved')
})

test('a no from the owner stops it, and she is told not to work around it', async () => {
  const { run, ran, audit } = await host(say('不允许'))
  const result = await run('git push origin main')
  assert.equal(result.isError, true)
  assert.deepEqual(ran, [])
  assert.match(JSON.stringify(result), /主人没有同意/)
  assert.match(JSON.stringify(result), /不要换个写法再试/)
  assert.deepEqual(
    audit().map(({ tier, decision }) => ({ tier, decision })),
    [{ tier: 'outward', decision: 'refused' }],
  )
})

test('with nobody to ask, a risky call is refused rather than let through', async () => {
  const { run, ran, audit } = await host('nobody')
  const result = await run('Get-Content .env')
  assert.equal(result.isError, true)
  assert.deepEqual(ran, [])
  assert.match(JSON.stringify(result), /现在没有人能回答/)
  assert.equal(audit()[0]?.decision, 'unanswered')
})

test('the question reaches the device in the owner’s hand, and the Web UI is not bothered', async () => {
  const device = { selected: ['允许这一次'], asked: [] as string[] }
  const { run, ran, asked, audit } = await host(say('不允许'), device)
  const result = await run('Remove-Item -Recurse old')
  assert.equal(result.isError, false)
  assert.deepEqual(ran, ['Remove-Item -Recurse old'])
  assert.equal(asked.length, 0, 'a device that answered means the Web UI never sees it')
  assert.match(device.asked[0]!, /删除或不可撤销：删除文件或文件夹/)
  assert.equal(audit()[0]?.decision, 'approved')
})

test('a device that cannot answer hands the question to the Web UI', async () => {
  const device = { selected: [] as string[], asked: [] as string[] }
  const { run, ran, asked, audit } = await host(say('不允许'), device)
  const result = await run('git push origin main')
  assert.equal(result.isError, true)
  assert.deepEqual(ran, [])
  assert.equal(device.asked.length, 1, 'the device was asked first')
  assert.equal(asked.length, 1, 'and the Web UI answered instead')
  assert.equal(audit()[0]?.decision, 'refused')
})

test('the owner can choose which tiers to be asked about', async () => {
  const auditPath = join(dir, 'tiers.jsonl')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {}).await()
  await ctx.plugin(ToolRuntime, {}).await()
  await ctx.plugin(UserQuestionService).await()
  let asked = 0
  ctx.on('user-questions/request', async () => {
    asked++
    return { answers: [{ id: 'fairy-guard', selected: ['不允许'] }] }
  })
  ctx.tools.register(
    defineTool({
      name: 'pwsh',
      description: 'test shell',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() {
        return 'done'
      },
    }),
  )
  await ctx.plugin(guard, { auditPath, ask: ['destructive'], askTimeoutMs: 5000 }).await()
  const run = (command: string) =>
    ctx.tools.execute({ callId: `c-${command.length}` as ToolExecutionInput['callId'], name: 'pwsh', arguments: { command }, signal: new AbortController().signal })
  assert.equal((await run('git push origin main')).isError, false)
  assert.equal((await run('rm -rf dist')).isError, true)
  assert.equal(asked, 1)
})

test('the command in the confirmation is shown as code, not as markdown or math', () => {
  const item = guard.confirmation('pwsh', { tier: 'destructive', why: ['删除文件或文件夹'] }, "$p = 'C:/tmp/a-b'; Remove-Item $p")
  assert.equal(item.detail, "工具：pwsh\n\n```\n$p = 'C:/tmp/a-b'; Remove-Item $p\n```")
})
