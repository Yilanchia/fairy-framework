import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { renderIdentity, renderSelfContext, renderStatus } from './render.js'
import type {} from './index.js'

/**
 * Her presence in one agent. Mounted inside the Fairy agent preset, so it runs once per session
 * while the self it reads from lives once per host.
 *
 * Who she is goes into a system-prompt section (stable, cache-friendly); what she is feeling and
 * doing goes into dynamic context, which DeepSeek Harness refreshes before every request.
 */
export const name = 'fairy-presence'
export const inject = ['fairySelf', 'systemPrompt', 'tools']

export interface Config {
  /** Prompt order of her identity; just after the deployment persona prefix (0). */
  identityOrder: number
  /** Context order of her current state; after DeepSeek Harness's own runtime context. */
  contextOrder: number
}

export const Config: z<Config> = z.object({
  identityOrder: z.number().default(50),
  contextOrder: z.number().default(300),
})

export function apply(ctx: Context, config: Config) {
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
    text: () => renderSelfContext(ctx.fairySelf.facts()),
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
}
