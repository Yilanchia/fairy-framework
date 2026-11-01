import {
  FairySelf,
  type FairyFact,
  type FairyHeard,
  type FairyIdentity,
  type FairyMemory,
  type FairyPerson,
  type FairySpeech,
  type FairyStatus,
} from '@fairy/core'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createRoom, FileArchive, Life } from '@isla/life'
import { isAbsolute } from 'node:path'
import { FAIRY_GENOME } from './genome.js'
import { lockLife } from './lock.js'
import { toFacts, toIdentity, toMemories, toStatus } from './translate.js'

export { FAIRY_GENOME, FAIRY_GENOME_INPUT } from './genome.js'
export { toFacts, toIdentity, toMemories, toStatus } from './translate.js'

export interface Config {
  /** Absolute path of her life log. The file is her: back it up, never commit it. */
  lifePath: string
  /** Seeds the weather of the small room she lives in. */
  worldSeed: string
  /** How often she lives up to the host clock, in milliseconds. */
  heartbeatMs: number
}

export const Config: z<Config> = z.object({
  lifePath: z.string().required().description('Absolute path of the life log (JSON Lines).'),
  worldSeed: z.string().default('fairy-room'),
  heartbeatMs: z.natural().min(1000).default(60_000),
})

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
        world: createRoom({ seed: this.config.worldSeed }),
        archive: new FileArchive(this.config.lifePath),
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
    })
    life.start(this.config.heartbeatMs)
    this.ctx.effect(() => async () => {
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

  async hear(person: FairyPerson, text: string): Promise<FairyHeard> {
    const { heard, said } = await this.alive().listen({ ...person, text })
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

  async remember(query: string, person?: FairyPerson): Promise<FairyMemory[]> {
    return toMemories(await this.alive().remember({ text: query, ...(person ? { personId: person.personId } : {}) }))
  }

  private alive(): Life {
    if (!this.life) throw new Error('fairy-isla: her life has not opened yet')
    return this.life
  }
}

export default IslaSelf
