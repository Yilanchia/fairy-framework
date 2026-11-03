import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** The owner's blog, as WordPress sees it. Credentials come from the deployment, never the repo. */
export interface BlogConfig {
  /** Site root, e.g. `https://lycoreco.cn`. */
  readonly url: string
  /** The WordPress user the application password belongs to. */
  readonly user: string
  /** A WordPress application password: 24 characters, usually written in four groups. */
  readonly password: string
}

export interface Config {
  /**
   * Blog tooling is opt-in: without these three values nothing is registered, so a deployment
   * without a blog simply has no `blog_publish`.
   */
  readonly blog?: BlogConfig
}

// Every field is optional at the schema level on purpose: schemastery validates an object's
// required fields even when the object itself is absent, which would stop the plugin from loading
// on a deployment with no blog at all. Missing values are reported when the tool is used.
export const Config: z<Config> = z.object({
  blog: z.object({ url: z.string(), user: z.string(), password: z.string() }),
})

/**
 * Fairy's hands: the tools that are hers rather than DeepSeek Harness's.
 *
 * Today that is the owner's blog. She publishes through WordPress's REST API with an application
 * password — she never reads the site's files or its database, which is also why her mount
 * namespace can keep `/www` invisible. Publishing is an outward action, so `fairy-guard` asks the
 * owner first, every time.
 */
export const name = 'fairy-hands'
export const inject = ['tools']

function credentials(blog: BlogConfig): string {
  // WordPress writes application passwords in groups; the spaces are presentation only.
  return Buffer.from(`${blog.user}:${blog.password.replace(/\s+/gu, '')}`, 'utf8').toString('base64')
}

export function apply(ctx: Context, config: Config) {
  const blog = config.blog
  if (!blog?.url || !blog.user || !blog.password) {
    ctx.logger.info('fairy-hands: no blog configured (FAIRY_BLOG_URL / _USER / _PASSWORD); blog_publish is off')
    return
  }
  const root = blog.url.replace(/\/+$/u, '')

  ctx.tools.register(
    defineTool({
      name: 'blog_publish',
      description:
        "Write a post on the owner's WordPress blog through its REST API. Saves a draft unless status is " +
        '"publish". The owner is asked to approve the call before it runs. Returns the post id and link.',
      parameters: {
        title: { type: 'string', required: true, description: 'The post title.' },
        content: {
          type: 'string',
          required: true,
          description: 'The post body, in HTML or the block markup the site accepts.',
        },
        status: {
          type: 'string',
          enum: ['draft', 'publish'],
          description: 'draft (the default) keeps it private; publish makes it public on the site.',
        },
        tags: { type: 'string', description: 'Comma-separated tag names; missing ones are created.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute({ title, content, status, tags }: { title: string; content: string; status?: string; tags?: string }) {
        const wanted = status === 'publish' ? 'publish' : 'draft'
        const body: Record<string, unknown> = { title, content, status: wanted }
        const names = (tags ?? '')
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
        if (names.length > 0) body.tags = names

        const response = await fetch(`${root}/wp-json/wp/v2/posts`, {
          method: 'POST',
          headers: {
            authorization: `Basic ${credentials(blog)}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        })
        const text = await response.text()
        if (!response.ok) {
          throw new Error(`WordPress refused the post (${response.status}): ${text.slice(0, 300)}`)
        }
        const post = JSON.parse(text) as { id?: number; link?: string; status?: string }
        const where = post.status === 'publish' ? '已发布' : '已存为草稿'
        return `${where}（id ${post.id ?? '?'}）：${post.link ?? `${root}/wp-admin/`}`
      },
    }),
  )
}
