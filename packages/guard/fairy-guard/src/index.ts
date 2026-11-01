import type { Context } from '@deepseek-ai/cordis'

/**
 * Fairy's guard. Placeholder: mounted on the host so the slot exists from day one.
 *
 * It will own her own risk tiers on top of DeepSeek Harness's sandbox and approval policy:
 * read-only, reversible local writes, outward-facing actions (sending, buying, posting) and
 * irreversible ones, each mapped to a confirmation rule, plus an append-only audit log of what
 * her hands did. Her mood never changes these rules. The hooks are `tools/pre-execute` for
 * decisions and `tools/result` for the log.
 */
export const name = 'fairy-guard'

export function apply(_ctx: Context) {}
