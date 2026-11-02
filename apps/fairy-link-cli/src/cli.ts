#!/usr/bin/env node
/**
 * A terminal device for Fairy's link. It is the acceptance check for phase 1: pair once with the
 * code the host printed, then send her something, ask how she is, look something up, and answer a
 * confirmation from the card in the terminal.
 *
 *   fairy-link pair --host http://127.0.0.1:3090 --code 123456
 *   fairy-link say "在吗"
 *   fairy-link status
 *   fairy-link recall 花生
 *
 * The token lives in `.fairy-link.json` next to where you ran `pair`; it is a device, so treat it
 * like one and do not commit it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { encode, parseHost, PROTOCOL_VERSION, type HostMessage } from '@fairy/protocol'
import { connect } from '@fairy/link'

interface Saved {
  host: string
  token: string
  name: string
}

const DEFAULTS = { host: 'http://127.0.0.1:3090', file: '.fairy-link.json', name: '我的终端' }

function flag(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : (args[index + 1] ?? fallback)
}

function save(path: string, saved: Saved): void {
  writeFileSync(path, `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function load(path: string): Saved {
  if (!existsSync(path)) throw new Error(`no device token at ${path}; run \`fairy-link pair --code …\` first`)
  const saved = JSON.parse(readFileSync(path, 'utf8')) as Saved
  if (!saved.token || !saved.host) throw new Error(`${path} is not a token this client wrote`)
  return saved
}

async function pair(args: string[]): Promise<void> {
  const host = flag(args, 'host', DEFAULTS.host)
  const file = flag(args, 'file', DEFAULTS.file)
  const name = flag(args, 'name', DEFAULTS.name)
  let code = flag(args, 'code', '')
  if (!code) {
    const ask = createInterface({ input: stdin, output: stdout })
    code = (await ask.question('配对码（宿主控制台上那 6 位）：')).trim()
    ask.close()
  }
  const response = await fetch(`${host.replace(/\/$/u, '')}/fairy/link/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name, kind: 'cli' }),
  })
  const answer = (await response.json()) as { token?: string; device?: { name: string }; error?: string }
  if (!response.ok || !answer.token) throw new Error(answer.error ?? `pairing failed (HTTP ${response.status})`)
  save(file, { host, token: answer.token, name: answer.device?.name ?? name })
  console.log(`配好了：${answer.device?.name}。令牌在 ${file}，别提交它。`)
}

/** Connects, says hello, and hands every frame to `onFrame` until that resolves. */
async function withDevice<T>(saved: Saved, onFrame: (message: HostMessage, peer: { send(text: string): void }) => T | undefined): Promise<T> {
  const url = `${saved.host.replace(/^http/u, 'ws').replace(/\/$/u, '')}/fairy/link/v1`
  const peer = await connect(url, 15_000)
  const result = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('没等到她的回应')), 300_000)
    peer.onMessage((raw) => {
      const parsed = parseHost(raw)
      if (!parsed.ok) return
      try {
        const value = onFrame(parsed.message, peer)
        if (value !== undefined) {
          clearTimeout(timer)
          resolve(value)
        }
      } catch (error) {
        clearTimeout(timer)
        reject(error as Error)
      }
    })
    peer.send(encode({ type: 'hello', id: 'hello', protocol: PROTOCOL_VERSION, token: saved.token, device: { name: saved.name, kind: 'cli' }, accepts: ['confirm'] }))
  })
  try {
    return await result
  } finally {
    peer.close()
  }
}

/** Answers a confirmation the way the owner would: read the option, pick one. */
function confirmCard(message: Extract<HostMessage, { type: 'confirm' }>, peer: { send(text: string): void }): void {
  console.log(`\n— 她要动一下手 —\n${message.question}`)
  if (message.detail) console.log(message.detail)
  message.options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}${option.description ? `（${option.description}）` : ''}`))
  const ask = createInterface({ input: stdin, output: stdout })
  void ask.question('选哪个（回车=不允许）：').then((line) => {
    const picked = Number.parseInt(line.trim(), 10)
    const option = Number.isInteger(picked) ? message.options[picked - 1] : message.options.find((row) => row.label === line.trim())
    const selected = option ? [option.label] : message.options.at(-1) ? [message.options.at(-1)!.label] : []
    peer.send(encode({ type: 'answer', id: `a-${message.id}`, confirm: message.id, selected }))
    ask.close()
  })
}

async function say(args: string[]): Promise<void> {
  const saved = load(flag(args, 'file', DEFAULTS.file))
  const words = args.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && args[index - 1]!.startsWith('--'))).join(' ')
  if (!words) throw new Error('要说什么？`fairy-link say "在吗"`')
  await withDevice(saved, (message, peer) => {
    if (message.type === 'welcome' && message.id === 'hello') {
      peer.send(encode({ type: 'say', id: 'say', text: words }))
      return undefined
    }
    if (message.type === 'confirm') {
      confirmCard(message, peer)
      return undefined
    }
    if (message.type === 'error') throw new Error(`${message.code}: ${message.message}`)
    if (message.type === 'reply.done') {
      console.log(`\nFairy：${message.text}`)
      return true
    }
    return undefined
  })
}

async function status(args: string[]): Promise<void> {
  const saved = load(flag(args, 'file', DEFAULTS.file))
  const answer = await withDevice(saved, (message, peer) => {
    if (message.type === 'welcome' && message.id === 'hello') {
      peer.send(encode({ type: 'status', id: 'status' }))
      return undefined
    }
    if (message.type === 'error') throw new Error(`${message.code}: ${message.message}`)
    return message.type === 'status' ? message : undefined
  })
  const state = answer.status
  console.log(
    `${answer.status.at > 0 ? new Date(state.at).toISOString() : ''} ${state.asleep ? '睡着' : `醒着${state.doing ? `，正在${state.doing}` : ''}`}`.trim(),
  )
  console.log(`心情 ${state.mood.toFixed(2)}，精力 ${Math.round(state.energy * 100)}%${state.bond ? `，和主人：${state.bond}` : ''}`)
}

async function recall(args: string[]): Promise<void> {
  const saved = load(flag(args, 'file', DEFAULTS.file))
  const query = args.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && args[index - 1]!.startsWith('--'))).join(' ')
  if (!query) throw new Error('要查什么？`fairy-link recall 花生`')
  const answer = await withDevice(saved, (message, peer) => {
    if (message.type === 'welcome' && message.id === 'hello') {
      peer.send(encode({ type: 'recall', id: 'recall', query }))
      return undefined
    }
    if (message.type === 'error') throw new Error(`${message.code}: ${message.message}`)
    return message.type === 'recall' ? message : undefined
  })
  const clarity = { clear: '清楚', vague: '模糊', faint: '很淡' } as const
  if (answer.memories.length === 0) console.log('什么也没想起来。')
  for (const memory of answer.memories) console.log(`[${memory.id}]（${clarity[memory.clarity]}）${memory.text}`)
}

const [command = 'help', ...rest] = process.argv.slice(2)
try {
  if (command === 'pair') await pair(rest)
  else if (command === 'say') await say(rest)
  else if (command === 'status') await status(rest)
  else if (command === 'recall') await recall(rest)
  else {
    console.log('fairy-link pair [--host URL] [--code 123456] [--name 名字]')
    console.log('fairy-link say "在吗"      # 说话，顺便回答她的确认')
    console.log('fairy-link status          # 她现在怎么样')
    console.log('fairy-link recall 花生      # 她记得什么')
    process.exitCode = command === 'help' ? 0 : 1
  }
} catch (error) {
  console.error(`fairy-link: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
