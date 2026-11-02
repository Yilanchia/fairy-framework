import {
  FairySelf,
  type FairyFact,
  type FairyHeard,
  type FairyIdentity,
  type FairyMemory,
  type FairyNote,
  type FairyPerception,
  type FairyPerson,
  type FairyShelfItem,
  type FairySpeech,
  type FairyStatus,
  type FairyUrge,
} from '@fairy/core'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ACTIVITIES, createRoom, FileArchive, Life, shelfActivity } from '@isla/life'
import { dirname, isAbsolute, join } from 'node:path'
import { backupLife } from './backup.js'
import { FAIRY_GENOME } from './genome.js'
import { lockLife } from './lock.js'
import { toFacts, toIdentity, toMemories, toStatus } from './translate.js'

export { FAIRY_GENOME, FAIRY_GENOME_INPUT } from './genome.js'
export { toFacts, toIdentity, toMemories, toStatus } from './translate.js'
export { formatInspection, inspect, readLife, type Inspection } from './inspect.js'

export interface Config {
  /** Absolute path of her life log. The file is her: back it up, never commit it. */
  lifePath: string
  /** Seeds the weather of the small room she lives in. */
  worldSeed: string
  /** How often she lives up to the host clock, in milliseconds. */
  heartbeatMs: number
  /** Where the daily copies of her life go. Default: a `backups` folder next to it. */
  backupDir?: string
  /** How many daily copies to keep. 0 turns backups off. */
  keepBackups: number
  /** Whether she may reach out to the owner on her own. The owner said yes on 2026-11-01. */
  reachOut: boolean
  ownerId: string
}

export const Config: z<Config> = z.object({
  lifePath: z.string().required().description('Absolute path of the life log (JSON Lines).'),
  worldSeed: z.string().default('fairy-room'),
  heartbeatMs: z.natural().min(1000).default(60_000),
  backupDir: z.string().description('Folder for daily copies of her life. Default: backups/ next to it.'),
  keepBackups: z.natural().default(14).description('Daily copies to keep; 0 turns backups off.'),
  reachOut: z.boolean().default(true).description('Let her message the owner of her own accord.'),
  ownerId: z.string().default('owner'),
})

/**
 * Her own pastimes, chosen by the owner on 2026-11-01: reading the news and looking through the
 * owner's projects, besides gazing out of the window, writing and resting. What is on each shelf
 * comes from `fairy-senses`; with an empty shelf she simply does something else.
 */
export const FAIRY_ACTIVITIES = [
  ...ACTIVITIES.filter((kind) => kind.id !== 'read'),
  shelfActivity({ id: 'news', label: '看新闻', verb: '读到', minutes: [10, 25] }),
  shelfActivity({
    id: 'projects',
    label: '翻主人的项目',
    verb: '翻到',
    minutes: [15, 35],
    satisfies: { curiosity: 0.25, connection: 0.1 },
  }),
]

const BACKUP_CHECK_MS = 60 * 60 * 1000

/**
 * Fairy's self as an Isla life. Mounted once on the host, so every session and every device that
 * reaches this host talks to the same her.
 *
 * Conversations enter her life: what the owner says is heard (`listen()`), what the DSH agent
 * says back is recorded (`speak()`), and her memory is Isla's, searched with `remember()`. Her
 * Isla mind stays the built-in inner mind, which never calls a model; she lives on her own
 * without spending tokens. External perceptions (`perceive()`) are still missing in Isla.
 */
export class IslaSelf extends FairySelf {
  static Config = Config

  private life: Life | undefined

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    super(ctx)
    if (!isAbsolute(config.lifePath)) {
      throw new Error(`fairy-isla: lifePath must be absolute, got ${JSON.stringify(config.lifePath)}`)
    }
  }

  async [Service.init]() {
    const logger = this.ctx.logger
    const release = lockLife(this.config.lifePath)
    let life: Life
    try {
      life = await Life.open({
        genome: FAIRY_GENOME,
        // Her window looks onto the owner's real sky, reported by fairy-senses; nothing is made up.
        // The bookshelf is replaced by her own pastimes.
        world: createRoom({ seed: this.config.worldSeed, books: [], sky: 'host' }),
        archive: new FileArchive(this.config.lifePath),
        activities: FAIRY_ACTIVITIES,
        ...(this.config.reachOut ? { reachOut: { personIds: [this.config.ownerId] } } : {}),
        logger: { warn: (message, error) => logger.warn(`fairy-isla: ${message}`, error) },
      })
      // Catch up on the time she was offline before anyone asks how she is.
      await life.tick()
    } catch (error) {
      release()
      throw error
    }
    this.life = life
    const unsubscribe = life.subscribe((event) => {
      this.ctx.emit('fairy/self-event', { id: event.id, at: event.at, kind: event.kind })
      if (event.kind === 'urged') {
        const person = life.state.people[event.payload.personId]
        this.ctx.emit('fairy/urge', {
          id: event.id,
          at: event.at,
          personId: event.payload.personId,
          ...(person?.name ? { name: person.name } : {}),
          why: event.payload.why,
          about: event.payload.about,
        })
      }
    })
    life.start(this.config.heartbeatMs)
    const backupDir = this.config.backupDir ?? join(dirname(this.config.lifePath), 'backups')
    const backup = () => {
      try {
        backupLife(this.config.lifePath, backupDir, this.config.keepBackups)
      } catch (error) {
        logger.warn('fairy-isla: could not back up her life', error)
      }
    }
    backup()
    const backups = setInterval(backup, BACKUP_CHECK_MS)
    backups.unref?.()
    this.ctx.effect(() => async () => {
      clearInterval(backups)
      unsubscribe()
      await life.stop()
      release()
    }, 'fairy-isla.life')
    logger.info(`fairy-isla: ${life.state.genome.name} is alive, ${life.events().length} events, mind ${life.mindName}`)
  }

  identity(): FairyIdentity {
    return toIdentity(this.alive().state)
  }

  status(): FairyStatus {
    return toStatus(this.alive().state)
  }

  facts(options: { readonly personId?: string; readonly cue?: string } = {}): FairyFact[] {
    return toFacts(this.alive().facts({ ...options }))
  }

  async hear(person: FairyPerson, text: string, where?: string): Promise<FairyHeard> {
    const { heard, said } = await this.alive().listen({ ...person, text, ...(where ? { where } : {}) })
    // listen() answers by itself only with the fixed crisis reply.
    return { id: heard.id, ...(said ? { urgent: said.payload.text } : {}) }
  }

  async speak(speech: FairySpeech): Promise<void> {
    await this.alive().speak({
      personId: speech.personId,
      inReplyTo: speech.inReplyTo,
      text: speech.text,
      speaker: speech.speaker,
    })
  }

  async perceive(perception: FairyPerception): Promise<void> {
    await this.alive().perceive({
      source: perception.source,
      what: perception.what,
      ...(perception.detail ? { detail: perception.detail } : {}),
      ...(perception.valence !== undefined ? { valence: perception.valence } : {}),
    })
  }

  async stock(item: FairyShelfItem): Promise<boolean> {
    const stocked = await this.alive().stock({
      shelf: item.shelf,
      item: item.item,
      title: item.title,
      text: item.text,
      tags: [...(item.tags ?? [])],
      source: item.source,
      ...(item.link ? { link: item.link } : {}),
    })
    return stocked !== undefined
  }

  async speakUp(urge: FairyUrge, text: string, speaker: string): Promise<void> {
    await this.alive().speak({ personId: urge.personId, inReplyTo: urge.id, text, speaker })
  }

  async note(note: FairyNote): Promise<void> {
    await this.alive().note({
      personId: note.personId,
      topic: note.topic,
      text: note.text,
      source: note.source,
      ...(note.pending ? { pending: true } : {}),
      ...(note.done ? { done: true } : {}),
    })
  }

  async remember(query: string, person?: FairyPerson): Promise<FairyMemory[]> {
    return toMemories(await this.alive().remember({ text: query, ...(person ? { personId: person.personId } : {}) }))
  }

  private alive(): Life {
    if (!this.life) throw new Error('fairy-isla: her life has not opened yet')
    return this.life
  }
}

export default IslaSelf
