import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as app from './index.js'

const hosts: Array<{ dispose(): Promise<void> }> = []
after(async () => {
  for (const fiber of hosts) await fiber.dispose()
})

async function host() {
  const ctx = new Context()
  const web = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await web.await()
  const page = ctx.plugin(app)
  await page.await()
  hosts.push(page, web)
  return `http://127.0.0.1:${ctx.webServer.port}`
}

test('the service worker is served too, because a closed page needs it', async () => {
  const base = await host()
  const worker = await fetch(`${base}/fairy/app/sw.js`)
  assert.equal(worker.status, 200)
  assert.match(worker.headers.get('content-type') ?? '', /javascript/)
  assert.match(await worker.text(), /addEventListener\('push'/u)
})

test('the manifest and icons are served, because iOS needs them to install her', async () => {
  const base = await host()
  const manifest = await fetch(`${base}/fairy/app/manifest.webmanifest`)
  assert.equal(manifest.status, 200)
  assert.match(manifest.headers.get('content-type') ?? '', /manifest\+json/)
  assert.match(await manifest.text(), /"display": "standalone"/u)

  const icon = await fetch(`${base}/fairy/app/icon-180.png`)
  assert.equal(icon.status, 200)
  assert.equal(icon.headers.get('content-type'), 'image/png')
  const bytes = new Uint8Array(await icon.arrayBuffer())
  // A PNG signature, not the utf8-mangled text of one.
  assert.deepEqual([...bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

test('her page, its script and the protocol module are all served', async () => {
  const base = await host()
  const page = await fetch(`${base}/fairy/app/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') ?? '', /text\/html/)
  assert.match(await page.text(), /<title>Fairy<\/title>/)

  const script = await fetch(`${base}/fairy/app/app.js`)
  assert.equal(script.status, 200)
  assert.match(script.headers.get('content-type') ?? '', /javascript/)
  assert.match(await script.text(), /parseHost/)

  // The browser loads the protocol package the host itself uses, not a hand-kept copy.
  const protocol = await fetch(`${base}/fairy/app/protocol.js`)
  assert.equal(protocol.status, 200)
  assert.match(await protocol.text(), /PROTOCOL_VERSION/)
})

test('the prefix sends the bare path to the canonical one, because relative URLs break otherwise', async () => {
  const base = await host()
  // Serving the page at `/fairy/app` made every relative URL resolve against `/fairy/`: the module
  // 404'd and the page hung on its boot screen. One redirect is cheaper than debugging that twice.
  const bare = await fetch(`${base}/fairy/app`, { redirect: 'manual' })
  assert.equal(bare.status, 308)
  assert.equal(bare.headers.get('location'), '/fairy/app/')

  const followed = await fetch(`${base}/fairy/app`)
  assert.equal(followed.status, 200)
  assert.match(await followed.text(), /<title>Fairy<\/title>/)
})

test('nothing else under the prefix is reachable, and bodies are not posted to', async () => {
  const base = await host()
  assert.equal((await fetch(`${base}/fairy/app/unknown.txt`)).status, 404)
  assert.equal((await fetch(`${base}/fairy/app/../package.json`)).status, 404, 'no traversal, because no path is read')
  assert.equal((await fetch(`${base}/fairy/app/`, { method: 'POST' })).status, 405)
})

test('the page may only load itself, and nothing is cached', async () => {
  const base = await host()
  const page = await fetch(`${base}/fairy/app/`)
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
})

test('a head request gets the headers without the body', async () => {
  const base = await host()
  const response = await fetch(`${base}/fairy/app/app.js`, { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '')
})
