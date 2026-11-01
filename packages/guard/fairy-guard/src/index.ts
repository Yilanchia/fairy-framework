import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import z from '@deepseek-ai/schemastery'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { describeCall, judge, type Tier, type Verdict } from './rules.js'

export { describeCall, judge, type Tier, type Verdict } from './rules.js'

/**
 * Fairy's guard. Mounted on the host, so it sees every tool call from every session.
 *
 * Before a risky call (deleting, sending something away, money or secrets) it asks the owner
 * through the same question card as `ask_user_question`, whatever DeepSeek Harness's own
 * approval policy says: the owner can give her full access and still be asked about these. With
 * nobody there to answer, the call is refused. Every call, asked about or not, goes into an
 * append-only audit log. Nothing here reads her mood.
 */
export const name = 'fairy-guard'
export const inject = ['tools', 'userQuestions']

export interface Config {
  /** Absolute path of the audit log (JSON Lines). */
  auditPath: string
  /** Tiers that need the owner's yes. The owner chose all three on 2026-11-01. */
  ask: Array<Exclude<Tier, 'routine'>>
}

export const Config: z<Config> = z.object({
  auditPath: z.string().required().description('Absolute path of the audit log (JSON Lines).'),
  ask: z.array(z.union(['destructive', 'outward', 'money'])).default(['destructive', 'outward', 'money']),
})

const ALLOW = '允许这一次'
const REFUSE = '不允许'

const TIER_WORDS: Record<Tier, string> = {
  routine: '普通操作',
  destructive: '删除或不可撤销',
  outward: '向外发送',
  money: '花钱或动凭据',
}

export interface AuditRecord {
  at: string
  tool: string
  tier: Tier
  why: string[]
  subject: string
  /** `allowed` for routine calls; otherwise what the owner said, or why nobody did. */
  decision: 'allowed' | 'approved' | 'refused' | 'unanswered'
  /** What the call returned: ok or the error it ended with. Absent when it never ran. */
  outcome?: 'ok' | 'error'
  session?: string
  callId?: string
}

/** Builds the confirmation the owner sees. Exported for tests. */
export function confirmation(tool: string, verdict: Verdict, subject: string): AskUserQuestionItem {
  return {
    id: 'fairy-guard',
    header: 'Fairy 想做一件需要你点头的事',
    question: `${TIER_WORDS[verdict.tier]}：${verdict.why.join('、')}。要让她做吗？`,
    // A fence, so `$p` and backslashes read as a command, not as math or escapes.
    detail: `工具：${tool}\n\n\`\`\`\n${subject.replaceAll('```', "'''")}\n\`\`\``,
    options: [
      { label: ALLOW, description: '只放行这一次，下次还会问。' },
      { label: REFUSE, description: '她会收到“主人没有同意”，换个办法或者问你。' },
    ],
  }
}

export function approved(answer: AskUserQuestionAnswer): boolean {
  return answer.answers.some((item) => item.selected.includes(ALLOW))
}

export function apply(ctx: Context, config: Config) {
  if (!isAbsolute(config.auditPath)) {
    throw new Error(`fairy-guard: auditPath must be absolute, got ${JSON.stringify(config.auditPath)}`)
  }
  mkdirSync(dirname(config.auditPath), { recursive: true })
  const ask = new Set(config.ask)
  const write = (record: AuditRecord) => {
    try {
      appendFileSync(config.auditPath, `${JSON.stringify(record)}\n`, 'utf8')
    } catch (error) {
      ctx.logger.warn('fairy-guard: could not write the audit log', error)
    }
  }
  // Decisions waiting for the call's result, so the log says how it ended.
  const pending = new Map<string, AuditRecord>()

  ctx.on('tools/pre-execute', async (exec, next) => {
    const verdict = judge({ name: exec.name, arguments: exec.arguments })
    const subject = describeCall({ name: exec.name, arguments: exec.arguments })
    const base = {
      at: new Date().toISOString(),
      tool: exec.name,
      tier: verdict.tier,
      why: verdict.why,
      subject,
      callId: String(exec.callId),
      ...(exec.agent ? { session: String(exec.agent.session.id) } : {}),
    }
    if (verdict.tier === 'routine' || !ask.has(verdict.tier)) {
      pending.set(String(exec.token), { ...base, decision: 'allowed' })
      return next()
    }
    let decision: AuditRecord['decision']
    try {
      const answer = await ctx.userQuestions.ask({
        questions: [confirmation(exec.name, verdict, subject)],
        ...(exec.agent ? { agent: exec.agent } : {}),
        signal: exec.signal,
      })
      decision = approved(answer) ? 'approved' : 'refused'
    } catch (error) {
      if (exec.signal.aborted) {
        write({ ...base, decision: 'unanswered' })
        return { kind: 'cancel' }
      }
      ctx.logger.warn('fairy-guard: nobody could be asked; refusing', error)
      decision = 'unanswered'
    }
    if (decision !== 'approved') {
      write({ ...base, decision })
      return {
        kind: 'deny',
        reason:
          decision === 'refused'
            ? `主人没有同意（${verdict.why.join('、')}）。不要换个写法再试；告诉主人你想做什么、为什么，或者换一个不需要确认的办法。`
            : `这件事需要主人确认（${verdict.why.join('、')}），但现在没有人能回答。先别做，等主人在的时候再问。`,
      }
    }
    pending.set(String(exec.token), { ...base, decision })
    return next()
  })

  ctx.on('tools/result', (exec, result) => {
    const record = pending.get(String(exec.token))
    if (!record) return
    pending.delete(String(exec.token))
    write({ ...record, outcome: result.isError ? 'error' : 'ok' })
  })
}
