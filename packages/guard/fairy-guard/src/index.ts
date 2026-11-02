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
  /**
   * How long the Web UI has to answer before the call is refused. Without a browser the question
   * waterfall can wait forever (measured 2026-11-02), and a turn that never ends is worse than a
   * refusal: the owner can always ask her again.
   */
  askTimeoutMs: number
}

export const Config: z<Config> = z.object({
  auditPath: z.string().required().description('Absolute path of the audit log (JSON Lines).'),
  ask: z.array(z.union(['destructive', 'outward', 'money'])).default(['destructive', 'outward', 'money']),
  askTimeoutMs: z.natural().min(1000).default(120_000).description('How long to wait for an answer before refusing.'),
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

/** The part of `@fairy/link` that asks a device; absent when no channel is mounted. */
interface Confirmer {
  confirm(
    question: {
      readonly id: string
      readonly question: string
      readonly header?: string
      readonly detail?: string
      readonly options?: ReadonlyArray<{ readonly label: string; readonly description?: string }>
    },
    signal?: AbortSignal,
  ): Promise<{ selected: string[] } | undefined>
}

/**
 * Asks the owner on whatever device is paired, if the channel is mounted and one can answer.
 * @returns true for yes, false for no, undefined when no device answered at all.
 */
async function askDevice(ctx: Context, item: AskUserQuestionItem, signal: AbortSignal): Promise<boolean | undefined> {
  const link = ctx.get('fairyLink') as Confirmer | undefined
  if (!link) return undefined
  const answer = await link.confirm(item, signal)
  return answer === undefined ? undefined : answer.selected.includes(ALLOW)
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
      // The owner's device first: it is the one they are holding, and a headless host has no
      // browser to answer the question waterfall — measured on 2026-11-02, where the card waited
      // forever in a Web UI nobody had open. A device that cannot answer (none paired, none
      // online, or none answered in time) hands the question on to the Web UI.
      const onDevice = await askDevice(ctx, confirmation(exec.name, verdict, subject), exec.signal)
      if (onDevice !== undefined) {
        decision = onDevice ? 'approved' : 'refused'
      } else {
        const answer = await Promise.race([
          ctx.userQuestions.ask({
            questions: [confirmation(exec.name, verdict, subject)],
            ...(exec.agent ? { agent: exec.agent } : {}),
            signal: exec.signal,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`nobody answered within ${config.askTimeoutMs}ms`)), config.askTimeoutMs).unref?.(),
          ),
        ])
        decision = approved(answer) ? 'approved' : 'refused'
      }
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
