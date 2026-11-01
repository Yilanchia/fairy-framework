import type { Context } from '@deepseek-ai/cordis'

/**
 * Fairy's senses. Placeholder: mounted on the host so the slot exists from day one.
 *
 * It will turn what happens around her (machine state, notifications, calendars, pages she
 * watches) into perceptions for her self. Her life must stay replayable, so a perception enters
 * as a logged event rather than something recomputed later; that needs a perception seam in
 * Isla first (`life.perceive()`), which does not exist yet.
 */
export const name = 'fairy-senses'

export function apply(_ctx: Context) {}
