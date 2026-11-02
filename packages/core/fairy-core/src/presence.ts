import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_BOND_TONES, DEFAULT_CHAT_STYLE, renderBondTone, renderIdentity, renderMemories, renderSelfContext, renderStatus } from './render.js'
import type { FairyBond, FairyPerson, FairyUrge } from './index.js'

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
  /** How she talks in a chat window; the deployment's, not her voice. */
  chatStyle: string
  /** How her tone changes as she comes to know the owner. */
  bondTones: Partial<Record<FairyBond, string>>
}

export const Config: z<Config> = z.object({
  identityOrder: z.number().default(50),
  contextOrder: z.number().default(300),
  ownerId: z.string().default('owner'),
  ownerName: z.string().default('主人'),
  maxRecordedChars: z.natural().default(2000),
  chatStyle: z.string().default(DEFAULT_CHAT_STYLE).description('How she talks in a chat window. Empty to leave it to her voice alone.'),
  bondTones: z
    .object({ stranger: z.string(), familiar: z.string(), close: z.string(), trusted: z.string() })
    .default(DEFAULT_BOND_TONES)
    .description('How her tone changes as she comes to know the owner, one line per step.'),
})

/** One session's turn in progress. */
interface Turn {
  /** Her `heard` event for the message this turn answers. */
  heard?: string
  /** Or the urge of her own that this turn says out loud. */
  urge?: FairyUrge
  /** Urges sent into this session, waiting for their turn to start. */
  pendingUrges: FairyUrge[]
  /** What was said to her, as the cue for what comes to mind. */
  cue?: string
  urgent?: string
  replies: string[]
  speaker?: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A turn Fairy starts herself, because she wanted to say something. */
    'fairy-urge': { kind: 'fairy-urge'; urge: string }
  }
}

const WHY_WORDS: Record<FairyUrge['why'], string> = {
  pending: '你还有一件答应主人的事没办完',
  share: '你刚看到一样东西，觉得主人会感兴趣',
  missed: '你有一阵子没和主人说话了，想找他聊聊',
}

/** What the model sees for a turn she starts. Nobody typed it, and it says so. */
export function renderUrge(urge: FairyUrge): string {
  return [
    '[FAIRY 主动开口]',
    '这不是主人发来的消息，是你自己想主动找主人说话。',
    `原因：${WHY_WORDS[urge.why]}——${urge.about}`,
    '用一两句话开个头，像平时说话一样，别解释这条提示，也别重复上面的格式。如果你觉得现在不该打扰，就只回一个“…”。',
  ].join('\n')
}

function urgeOf(messages: readonly UserMessage[]): string | undefined {
  for (const message of messages) {
    const source = message.source as { kind: string; urge?: string }
    if (source.kind === 'fairy-urge' && source.urge) return source.urge
  }
  return undefined
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
    if (!turn) turns.set(session, (turn = { replies: [], pendingUrges: [] }))
    return turn
  }
  // Her open conversations, so an urge can go to the one the owner used last.
  const agents = new Map<Session, { agent: Agent; lastSeen: number }>()
  ctx.on('session/disposed', (session) => {
    turns.delete(session)
    agents.delete(session)
  })

  ctx.systemPrompt.section({
    name: 'fairy:identity',
    order: config.identityOrder,
    // Her voice and origin are her own words; they must not be read as prompt templates.
    interpolate: false,
    text: () => renderIdentity(ctx.fairySelf.identity(), config.chatStyle),
  })

  ctx.systemPrompt.context({
    name: 'fairy:self',
    order: config.contextOrder,
    interpolate: false,
    text: (context) => {
      const turn = context.agent ? turns.get(context.agent.session) : undefined
      const facts = ctx.fairySelf.facts({ personId: owner.personId, ...(turn?.cue ? { cue: turn.cue } : {}) })
      const bond = ctx.fairySelf.status().bonds?.[owner.personId]
      return [renderBondTone(bond, config.bondTones), renderSelfContext(facts, turn?.urgent)].filter(Boolean).join('\n\n')
    },
  })

  // Before the model is asked: she hears it, wakes if she has to, and feels it. Awaited, so the
  // context refreshed for this very request already shows it.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    agents.set(payload.agent.session, { agent: payload.agent, lastSeen: Date.now() })
    const turn = turnOf(payload.agent.session)
    // A turn she starts herself answers one of her urges, not anything the owner said.
    const urgeId = urgeOf(payload.messages)
    if (urgeId) {
      const index = turn.pendingUrges.findIndex((urge) => urge.id === urgeId)
      if (index !== -1) {
        turn.urge = turn.pendingUrges.splice(index, 1)[0]!
        delete turn.heard
        turn.replies = []
      }
      return decision
    }
    const text = humanText(payload.messages)
    if (!text) return decision
    try {
      const heard = await ctx.fairySelf.hear(owner, text, `dsh-session:${payload.agent.session.id}`)
      turn.heard = heard.id
      delete turn.urge
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
    if (!turn?.heard && !turn?.urge) return
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
    const { heard, urge } = turn
    const text = clip(turn.replies.join('\n\n').trim(), config.maxRecordedChars)
    const speaker = turn.speaker ?? 'dsh'
    delete turn.heard
    delete turn.urge
    delete turn.urgent
    turn.replies = []
    // A turn that failed before saying anything leaves what she heard unanswered, as it was; an
    // urge she decided not to act on ("…") was never said.
    if (!text || (urge && /^[.…。\s]*$/u.test(text))) return
    const recorded = heard
      ? ctx.fairySelf.speak({ ...owner, inReplyTo: heard, text, speaker })
      : ctx.fairySelf.speakUp(urge!, text, speaker)
    recorded.catch((error: unknown) => ctx.logger.warn('fairy-presence: could not record her reply', error))
  })

  // She wants to talk to the owner of her own accord: carry it into the conversation they last
  // had with her, as a turn of its own that she starts.
  ctx.on('fairy/urge', (urge) => {
    if (urge.personId !== owner.personId) return
    const target = [...agents.values()].sort((left, right) => right.lastSeen - left.lastSeen)[0]
    if (!target) {
      ctx.logger.info(`fairy-presence: she wanted to say something (${urge.about}) but no conversation is open`)
      return
    }
    const turn = turnOf(target.agent.session)
    turn.pendingUrges.push(urge)
    target.agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: renderUrge(urge) }],
        source: { kind: 'fairy-urge', urge: urge.id },
      }),
    )
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
