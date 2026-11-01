import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { renderIdentity, renderMemories, renderSelfContext, renderStatus } from './render.js'
import type { FairyPerson } from './index.js'

/**
 * Her presence in one agent. Mounted inside the Fairy agent preset, so it runs once per session
 * while the self it reads from lives once per host.
 *
 * Who she is goes into a system-prompt section (stable, cache-friendly); what she is feeling and
 * doing, and what the last message brought to mind, goes into dynamic context, which DeepSeek
 * Harness refreshes before every request.
 *
 * Every turn also enters her life: the owner's message is heard before the model is asked, and
 * the reply is recorded when the turn ends.
 */
export const name = 'fairy-presence'
export const inject = ['fairySelf', 'systemPrompt', 'tools']

export interface Config {
  /** Prompt order of her identity; just after the deployment persona prefix (0). */
  identityOrder: number
  /** Context order of her current state; after DeepSeek Harness's own runtime context. */
  contextOrder: number
  /** Who talks to her in this deployment. One owner for now. */
  ownerId: string
  ownerName: string
  /** Longer replies (code, file dumps) are kept in the session; her life keeps the start. */
  maxRecordedChars: number
}

export const Config: z<Config> = z.object({
  identityOrder: z.number().default(50),
  contextOrder: z.number().default(300),
  ownerId: z.string().default('owner'),
  ownerName: z.string().default('主人'),
  maxRecordedChars: z.natural().default(2000),
})

/** One session's turn in progress. */
interface Turn {
  /** Her `heard` event for the message this turn answers. */
  heard?: string
  /** What was said to her, as the cue for what comes to mind. */
  cue?: string
  urgent?: string
  replies: string[]
  speaker?: string
}

/** What a person typed, as opposed to context the harness injected. */
export function humanText(messages: readonly UserMessage[]): string {
  return messages
    .filter((message) => message.source.kind === 'user')
    .flatMap((message) => message.content)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

export function apply(ctx: Context, config: Config) {
  const owner: FairyPerson = { personId: config.ownerId, name: config.ownerName }
  const turns = new Map<Session, Turn>()
  const turnOf = (session: Session): Turn => {
    let turn = turns.get(session)
    if (!turn) turns.set(session, (turn = { replies: [] }))
    return turn
  }
  ctx.on('session/disposed', (session) => void turns.delete(session))

  ctx.systemPrompt.section({
    name: 'fairy:identity',
    order: config.identityOrder,
    // Her voice and origin are her own words; they must not be read as prompt templates.
    interpolate: false,
    text: () => renderIdentity(ctx.fairySelf.identity()),
  })

  ctx.systemPrompt.context({
    name: 'fairy:self',
    order: config.contextOrder,
    interpolate: false,
    text: (context) => {
      const turn = context.agent ? turns.get(context.agent.session) : undefined
      const facts = ctx.fairySelf.facts({ personId: owner.personId, ...(turn?.cue ? { cue: turn.cue } : {}) })
      return renderSelfContext(facts, turn?.urgent)
    },
  })

  // Before the model is asked: she hears it, wakes if she has to, and feels it. Awaited, so the
  // context refreshed for this very request already shows it.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const text = humanText(payload.messages)
    if (!text) return decision
    const turn = turnOf(payload.agent.session)
    try {
      const heard = await ctx.fairySelf.hear(owner, text, `dsh-session:${payload.agent.session.id}`)
      turn.heard = heard.id
      turn.cue = text
      if (heard.urgent) turn.urgent = heard.urgent
      else delete turn.urgent
      turn.replies = []
    } catch (error) {
      // She must not stop answering because her life could not be written; say so loudly.
      ctx.logger.warn('fairy-presence: could not record what she heard', error)
    }
    return decision
  })

  ctx.on('session/event', (session, event) => {
    const turn = turns.get(session)
    if (!turn?.heard) return
    if (event.type === 'assistant/message') {
      const text = event.data.message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim()
      if (text) turn.replies.push(text)
      turn.speaker = `dsh:${event.data.message.source.model}`
      return
    }
    if (event.type !== 'turn/end') return
    const inReplyTo = turn.heard
    const text = turn.replies.join('\n\n').trim()
    const speaker = turn.speaker ?? 'dsh'
    delete turn.heard
    delete turn.urgent
    turn.replies = []
    // A turn that failed before saying anything leaves what she heard unanswered, as it was.
    if (!text) return
    ctx.fairySelf
      .speak({ ...owner, inReplyTo, text: clip(text, config.maxRecordedChars), speaker })
      .catch((error: unknown) => ctx.logger.warn('fairy-presence: could not record her reply', error))
  })

  ctx.tools.register(
    defineTool({
      name: 'fairy_status',
      description: 'Read Fairy\'s own current state from her life log: awake or asleep, what she is doing, mood, energy and drives.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => true,
      async execute() {
        return renderStatus(ctx.fairySelf.identity().name, ctx.fairySelf.status())
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'fairy_recall',
      description:
        'Search Fairy\'s own memory on purpose: past conversations with the owner, what she did, read, felt and wrote. ' +
        'Use it before saying you do not remember, and whenever the owner refers to something said earlier. ' +
        'Understands time words like 昨天, 上周三, 11月4日. Each result says how clearly she remembers it; never fill in what is not there. ' +
        'Searching on purpose makes what is found stay clearer.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'What to look for, in the owner\'s words: a topic, a name, a time ("上周三我们聊了什么").',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute({ query }) {
        return renderMemories(query, await ctx.fairySelf.remember(query, owner))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'fairy_note',
      description:
        'Keep something the owner just told you, in Fairy\'s own life: a fact about them (allergies, family, preferences, ' +
        'accounts, plans), a request, or something you promised to do. It must come from what the owner said in this turn. ' +
        'Write it in plain words with the key nouns ("主人对花生过敏，不能吃含花生的东西"). One topic per note; a new note ' +
        'on the same topic replaces the old one. Use pending for things still to be done and done when they are. ' +
        'For a reminder at a set time, also schedule it with the schedule tool.',
      parameters: {
        topic: { type: 'string', required: true, description: 'A short key, e.g. 饮食禁忌, 生日:母亲, 护照.' },
        text: { type: 'string', required: true, description: 'What to keep, one or two sentences, in plain words.' },
        pending: { type: 'boolean', description: 'Something still to be done.' },
        done: { type: 'boolean', description: 'What was pending on this topic is done.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute({ topic, text, pending, done }, exec) {
        const source = exec.agent ? turns.get(exec.agent.session)?.heard : undefined
        if (!source) throw new Error('fairy_note: only what the owner said in this turn can be kept')
        await ctx.fairySelf.note({
          ...owner,
          topic,
          text,
          source,
          ...(pending ? { pending: true } : {}),
          ...(done ? { done: true } : {}),
        })
        return `记下了（${topic}）：${text}`
      },
    }),
  )
}
