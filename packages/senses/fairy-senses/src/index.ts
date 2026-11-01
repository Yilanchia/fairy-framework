import type { Context } from '@deepseek-ai/cordis'

/**
 * Fairy's senses. Placeholder: mounted on the host so the slot exists from day one.
 *
 * It will turn what happens around her (machine state, notifications, calendars, pages she
 * watches) into perceptions with `ctx.fairySelf.perceive({ source, what, detail, valence })`.
 * Each enters her life as a logged event, so it stays replayable. Asleep she notices nothing;
 * what she feels about it is her own, the sense's `valence` only nudges it; the same thing many
 * times a day stops being news. Which senses to give her, and with what consent, is the owner's
 * call: none are on yet.
 */
export const name = 'fairy-senses'

export function apply(_ctx: Context) {}
