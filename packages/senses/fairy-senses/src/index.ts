import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@fairy/core'
import { parseFeed, withoutPromotion } from './feed.js'
import { readProject } from './projects.js'
import { readSky } from './weather.js'

export { parseFeed, plain, withoutPromotion, type FeedItem } from './feed.js'
export { parseLog, readProject, subjects, type ProjectItem } from './projects.js'
export { kindOf, parseSky, readSky, type Sky } from './weather.js'

/**
 * Fairy's senses: what she comes across outside the conversation. Mounted on the host.
 *
 * Today two, both chosen by the owner on 2026-11-01:
 * - `feeds`: news from the RSS or Atom feeds listed here, onto her `news` shelf.
 * - `projects`: the latest commits of the git repositories listed here, onto her `projects`
 *   shelf. Read-only: `git log`, nothing else.
 *
 * Nothing is read until the owner lists something. What she does with it, and when, is up to her.
 */
export const name = 'fairy-senses'
export const inject = ['fairySelf']

export interface Feed {
  url: string
  /** Shown as where it came from; default the feed's host. */
  name?: string
  /** Added to every item's tags, e.g. `科技`. */
  tags?: string[]
}

export interface Config {
  feeds: Feed[]
  /** Absolute paths of git repositories she may look through. */
  projects: string[]
  /** How often to look, in minutes. */
  everyMinutes: number
  /** At most this many new things per source per look, so one busy feed does not crowd out the rest. */
  perSource: number
  /**
   * The sky out of her window is the one over the owner's city. Without it she has no weather at
   * all rather than a made-up one.
   */
  weather?: { city?: string; query?: string; everyMinutes: number }
}

export const Config: z<Config> = z.object({
  feeds: z
    .array(z.object({ url: z.string().required(), name: z.string(), tags: z.array(z.string()) }))
    .default([])
    .description('RSS or Atom feeds for her news shelf.'),
  projects: z.array(z.string()).default([]).description('Git repositories she may look through, read-only.'),
  everyMinutes: z.natural().min(5).default(60),
  perSource: z.natural().min(1).default(5),
  weather: z
    .object({ city: z.string(), query: z.string(), everyMinutes: z.natural().min(10).default(30) })
    .description('The sky out of her window: the owner\'s city, from wttr.in. No city, no weather.'),
})

const SUMMARY_CHARS = 400

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function apply(ctx: Context, config: Config) {
  const look = async () => {
    for (const feed of config.feeds) {
      try {
        const response = await fetch(feed.url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'fairy-senses' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const items = parseFeed(await response.text())
          .sort((left, right) => (left.at ?? 0) - (right.at ?? 0))
          .slice(-config.perSource)
        const source = feed.name ?? hostOf(feed.url)
        for (const item of items) {
          await ctx.fairySelf.stock({
            shelf: 'news',
            item: `${feed.url}#${item.id}`,
            title: item.title,
            text: withoutPromotion(item.summary).slice(0, SUMMARY_CHARS),
            tags: [...(feed.tags ?? []), ...item.tags].slice(0, 6),
            source,
            ...(item.link ? { link: item.link } : {}),
          })
        }
      } catch (error) {
        ctx.logger.warn(`fairy-senses: could not read ${feed.url}`, error)
      }
    }
    for (const dir of config.projects) {
      try {
        // Oldest first, so she comes across a project's history in the order it happened.
        for (const item of (await readProject(dir, config.perSource)).reverse()) {
          await ctx.fairySelf.stock({ shelf: 'projects', item: item.id, title: item.title, text: item.text, tags: item.tags, source: item.source })
        }
      } catch (error) {
        ctx.logger.warn(`fairy-senses: could not look through ${dir}`, error)
      }
    }
  }
  if (config.weather?.city) watchSky(ctx, config.weather.city, config.weather)
  if (config.feeds.length === 0 && config.projects.length === 0) {
    ctx.logger.info('fairy-senses: no feeds or projects listed yet; her news and projects shelves stay empty')
    return
  }
  let running: Promise<void> | undefined
  const tick = () => {
    // One look at a time; a slow feed must not pile up behind itself.
    running ??= look().finally(() => (running = undefined))
  }
  const first = setTimeout(tick, 10_000)
  const timer = setInterval(tick, config.everyMinutes * 60_000)
  first.unref?.()
  timer.unref?.()
  ctx.effect(() => () => {
    clearTimeout(first)
    clearInterval(timer)
  }, 'fairy-senses.timer')
}

/** The sky over the owner's city, looked at more often than the news. Her life skips repeats. */
function watchSky(ctx: Context, city: string, weather: NonNullable<Config['weather']>) {
  const look = async () => {
    try {
      const sky = await readSky(city, weather.query ?? city)
      if (sky) await ctx.fairySelf.perceive({ source: 'weather', what: sky.what, detail: sky.kind })
    } catch (error) {
      ctx.logger.warn(`fairy-senses: could not see the sky over ${city}`, error)
    }
  }
  const first = setTimeout(() => void look(), 5_000)
  const timer = setInterval(() => void look(), weather.everyMinutes * 60_000)
  first.unref?.()
  timer.unref?.()
  // Asleep she notices nothing; the first thing she does on waking is look out of the window.
  ctx.on('fairy/self-event', (event) => {
    if (event.kind === 'woke') void look()
  })
  ctx.effect(() => () => {
    clearTimeout(first)
    clearInterval(timer)
  }, 'fairy-senses.sky')
}
