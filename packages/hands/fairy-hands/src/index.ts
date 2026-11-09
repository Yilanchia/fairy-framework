import { existsSync, mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { archive, create as createWorkspace, directories, list as listWorkspaces, type Created } from './workspaces.js'

/** The owner's blog, as WordPress sees it. Credentials come from the deployment, never the repo. */
export interface BlogConfig {
  /** Site root, e.g. `https://lycoreco.cn`. */
  readonly url: string
  /** The WordPress login name — not the display name. It may contain spaces. */
  readonly user: string
  /** A WordPress application password: 24 characters, usually written in four groups. */
  readonly password: string
}

/** Where she is allowed to work, and how many rooms she may have open at once. */
export interface WorkspaceConfig {
  /** The one directory she owns; every room is a subdirectory of it. */
  readonly root: string
  /** Open rooms allowed at the same time. Full means archive one first. */
  readonly max: number
}

export interface Config {
  /** Blog tooling is opt-in: without these three values there is no `blog_publish`. */
  readonly blog?: BlogConfig
  /** Workspace tooling is opt-in the same way: no root, no tools. */
  readonly workspace?: WorkspaceConfig
}

// Every field is optional at the schema level on purpose: schemastery validates an object's
// required fields even when the object itself is absent, which would stop the plugin from loading
// on a deployment with none of this configured. Missing values are reported when a tool is used.
export const Config: z<Config> = z.object({
  blog: z.object({ url: z.string(), user: z.string(), password: z.string() }),
  workspace: z.object({ root: z.string(), max: z.natural().min(1).default(8) }),
})

/**
 * Fairy's hands: the tools that are hers rather than DeepSeek Harness's.
 *
 * Two things live here.
 *
 * The blog: she publishes through WordPress's XML-RPC endpoint, not the REST API, because this
 * host's nginx does not forward the `Authorization` header to PHP-FPM — REST application-password
 * auth answers 401 even with correct credentials, while XML-RPC carries the credentials in the body
 * and works without touching the blog's server configuration. She never reads the site's files or
 * its database, which is why `/www` stays invisible to her mount namespace.
 *
 * The workspace: one directory she owns, divided into named rooms with a README each, and a hard
 * cap on how many may be open. The cap is the point — without it "she organises herself" becomes
 * a hundred abandoned folders. Archiving moves a room aside rather than deleting it.
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

function blogTools(ctx: Context, blog: BlogConfig): void {
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

function textTool(name: string, description: string, parameters: Record<string, unknown>, run: (args: Record<string, string>) => string) {
  return defineTool({
    name,
    description,
    parameters: parameters as never,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args: Record<string, string>) {
      return run(args)
    },
  })
}

function workspaceTools(ctx: Context, config: WorkspaceConfig): void {
  const root = config.root
  mkdirSync(root, { recursive: true })

  ctx.tools.register(
    textTool(
      'workspace_list',
      'List the work rooms the owner can see: name, why, and what is on disk. Use it before opening a new one.',
      {},
      () => {
        const rooms = listWorkspaces(root)
        const onDisk = directories(root)
        if (rooms.length === 0) return `现在没有开着的工作区。她的目录是 ${root}，里面：${onDisk.join(', ') || '空'}。`
        const lines = rooms.map((room) => `- ${room.name}（${room.slug}）：${room.why || '（没写）'}`)
        return `开着 ${rooms.length}/${config.max} 个工作区：\n${lines.join('\n')}`
      },
    ),
  )

  ctx.tools.register(
    textTool(
      'workspace_new',
      'Open a work room for one project inside her own directory: creates the folder and a README she owns. ' +
        `At most ${config.max} may be open; when full, archive one with workspace_archive first.`,
      {
        name: { type: 'string', required: true, description: 'What the owner would call this project.' },
        why: { type: 'string', required: true, description: 'One line on what this room is for; it goes into the README.' },
      },
      (args) => {
        const created: Created = createWorkspace(root, config.max, args.name ?? '', args.why ?? '')
        return `开好了：${created.workspace.name}，目录 ${created.path}。README 已经写进去了，接下来在这个目录里干活。`
      },
    ),
  )

  ctx.tools.register(
    textTool(
      'workspace_archive',
      'Close a work room by archiving it: the folder moves to .archive/, nothing is deleted. Use when the work is done ' +
        'or when the open limit is reached.',
      { slug: { type: 'string', required: true, description: 'The slug from workspace_list.' } },
      (args) => {
        const slug = (args.slug ?? '').trim()
        if (!existsSync(root)) throw new Error('她的工作目录还没建。')
        const moved = archive(root, slug)
        return `归档了 ${slug}，移到了 ${moved}。里面的东西都还在。`
      },
    ),
  )
}

export function apply(ctx: Context, config: Config) {
  const blog = config.blog
  if (blog?.url && blog.user && blog.password) blogTools(ctx, blog)
  else ctx.logger.info('fairy-hands: no blog configured (FAIRY_BLOG_URL / _USER / _PASSWORD); blog_publish is off')

  const workspace = config.workspace
  if (workspace?.root) workspaceTools(ctx, { root: workspace.root, max: workspace.max ?? 8 })
  else ctx.logger.info('fairy-hands: no workspace configured (FAIRY_SESSION_CWD); workspace tools are off')
}
