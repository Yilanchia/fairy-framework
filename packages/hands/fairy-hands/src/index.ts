import type { Context } from '@deepseek-ai/cordis'

/**
 * Fairy's hands. Placeholder: mounted in the Fairy agent preset so the slot exists from day one.
 *
 * Today her hands are DeepSeek Harness's own shell, file and web tools, listed in the bundle's
 * preset. Tools of her own (devices, home, accounts, other machines) register here with
 * `ctx.tools.register()`, or arrive as MCP servers, and every one of them passes `fairy-guard`.
 */
export const name = 'fairy-hands'

export function apply(_ctx: Context) {}
