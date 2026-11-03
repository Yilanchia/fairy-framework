import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** The owner's blog, as WordPress sees it. Credentials come from the deployment, never the repo. */
export interface BlogConfig {
  /** Site root, e.g. `https://lycoreco.cn`. */
  readonly url: string
  /** The WordPress login name — not the display name. It may contain spaces. */
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
 * Today that is the owner's blog. She publishes through WordPress's XML-RPC endpoint, not the REST
 * API, because this host's nginx does not forward the `Authorization` header to PHP-FPM — REST
 * application-password auth answers 401 even with correct credentials, while XML-RPC carries the
 * credentials in the body and works without touching the blog's server configuration.
 *
 * She still never reads the site's files or its database, which is why `/www` stays invisible to
 * her mount namespace. Publishing is an outward action, so `fairy-guard` asks the owner first.
 */
export const name = 'fairy-hands'
export const inject = ['tools']

function escapeXml(value: string): string {
  return value
    // XML 1.0 cannot carry most control characters, not even escaped.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function member(name: string, value: string): string {
  return `<member><name>${name}</name><value><string>${escapeXml(value)}</string></value></member>`
}

/** WordPress writes application passwords in groups; the spaces are presentation only. */
function tidy(password: string): string {
  return password.replace(/\s+/gu, '')
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
        "Write a post on the owner's WordPress blog. Saves a draft unless status is 'publish'. " +
        'The owner is asked to approve the call before it runs. Returns the post id and link.',
      parameters: {
        title: { type: 'string', required: true, description: 'The post title.' },
        content: { type: 'string', required: true, description: 'The post body, in HTML or block markup.' },
        status: {
          type: 'string',
          enum: ['draft', 'publish'],
          description: 'draft (the default) keeps it private; publish makes it public on the site.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute({ title, content, status }: { title: string; content: string; status?: string }) {
        const wanted = status === 'publish' ? 'publish' : 'draft'
        const xml = [
          '<?xml version="1.0"?>',
          '<methodCall><methodName>wp.newPost</methodName><params>',
          '<param><value><int>0</int></value></param>',
          `<param><value><string>${escapeXml(blog.user)}</string></value></param>`,
          `<param><value><string>${escapeXml(tidy(blog.password))}</string></value></param>`,
          '<param><value><struct>',
          member('post_type', 'post'),
          member('post_status', wanted),
          member('post_title', title),
          member('post_content', content),
          '</struct></value></param>',
          '</params></methodCall>',
        ].join('')

        const response = await fetch(`${root}/xmlrpc.php`, {
          method: 'POST',
          headers: { 'content-type': 'text/xml', accept: 'text/xml' },
          body: xml,
          signal: AbortSignal.timeout(30_000),
        })
        const text = await response.text()
        const fault = /<name>faultString<\/name>\s*<value><string>([\s\S]*?)<\/string>/u.exec(text)
        if (fault) throw new Error(`WordPress refused the post: ${fault[1]!.trim()}`)
        if (!response.ok) throw new Error(`WordPress answered ${response.status}: ${text.slice(0, 200)}`)
        const id = /<int>(\d+)<\/int>/u.exec(text)?.[1]
        if (!id) throw new Error(`WordPress did not return a post id: ${text.slice(0, 200)}`)
        return `${wanted === 'publish' ? '已发布' : '已存为草稿'}（id ${id}）：${root}/?p=${id}`
      },
    }),
  )
}
