import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/**
 * Her own page, served by the host she already runs.
 *
 * It is a plain static shell — one HTML file, one script, and the protocol package copied out as
 * a module — reached at `/fairy/app/`. There is no bundler and no build step for the client: the
 * only shared code is `@fairy/protocol`, whose compiled ESM has no imports, so the browser can load
 * it as it is. That is deliberate: an app that needs a toolchain to change is an app nobody keeps
 * changing (docs/app.md).
 */
export const name = 'fairy-app'
export const inject = ['webServer']

/** Served files, by the path under the prefix. Only these, ever. */
const FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'web/index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'web/index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'web/app.js', type: 'text/javascript; charset=utf-8' },
  // The service worker has to come from this origin and from this scope; it is what shows her
  // notifications while the page is closed.
  '/sw.js': { file: 'web/sw.js', type: 'text/javascript; charset=utf-8' },
}

const PREFIX = '/fairy/app'

/** The protocol package's compiled module, which the page imports instead of a copy. */
function protocolModule(): string {
  return readFileSync(fileURLToPath(import.meta.resolve('@fairy/protocol')), 'utf8')
}

export function apply(ctx: Context) {
  // dist/index.js → the package root, where `web/` sits.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  let protocol: string
  try {
    protocol = protocolModule()
  } catch (error) {
    ctx.logger.warn('fairy-app: could not read the protocol module; the page will not load', error)
    protocol = 'export const PROTOCOL_VERSION = 0\n'
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req: IncomingMessage, res: ServerResponse) => {
          const path = (req.url ?? '/').split('?', 1)[0]!.slice(PREFIX.length) || '/'
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET, HEAD' })
            res.end()
            return
          }
          // Everything the page needs is known by name; nothing is read from a path the request
          // supplied, so there is no traversal to defend against.
          if (path === '/protocol.js') {
            send(res, 'text/javascript; charset=utf-8', protocol, req.method === 'HEAD')
            return
          }
          const entry = FILES[path]
          if (!entry) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('not found')
            return
          }
          let body: string
          try {
            body = readFileSync(join(root, entry.file), 'utf8')
          } catch (error) {
            ctx.logger.warn(`fairy-app: ${entry.file} is missing from the package`, error)
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('missing')
            return
          }
          send(res, entry.type, body, req.method === 'HEAD')
        },
      }),
    'fairy-app.page',
  )
}

function send(res: ServerResponse, type: string, body: string, headOnly: boolean): void {
  res.writeHead(200, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    // The page changes only when the host restarts, and the owner reloads by hand.
    'cache-control': 'no-store',
    // Nothing here loads anything from anywhere else.
    'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss:; style-src 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
  })
  res.end(headOnly ? undefined : body)
}
