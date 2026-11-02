/**
 * Just enough of RFC 6455 for one JSON message per frame: the handshake accept, a text-frame
 * codec, fragmentation reassembly, and ping/close. No binary messages, no extensions, no
 * compression — the wire here carries short JSON objects between one owner and one host.
 *
 * Written by hand because this repo takes no new runtime dependencies for a protocol this small,
 * and the only TypeScript types for a WebSocket library are not in the offline store.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
/** A frame larger than this is not something the owner typed; drop the peer instead of buffering. */
const MAX_PAYLOAD = 1024 * 1024

export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const

/** The header value proving the peer speaks WebSocket and not something that merely upgrades. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}${GUID}`, 'utf8').digest('base64')
}

/** One peer's bytes as protocol frames, reassembling fragments until a message is complete. */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []

  /** @param masked whether frames from this peer must be masked (true for what a client sends). */
  constructor(private readonly masked: boolean) {}

  /** Feeds bytes and returns every complete message they finish, plus control frames to answer. */
  push(chunk: Buffer): Array<{ opcode: number; text?: string }> {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const done: Array<{ opcode: number; text?: string }> = []
    for (;;) {
      const frame = this.read()
      if (!frame) return done
      if (frame.opcode === OPCODE.ping) {
        done.push({ opcode: OPCODE.ping })
        continue
      }
      if (frame.opcode === OPCODE.pong) continue
      if (frame.opcode === OPCODE.close) {
        done.push({ opcode: OPCODE.close })
        continue
      }
      if (frame.opcode === OPCODE.binary) throw new Error('binary frames are not part of this wire')
      if (frame.opcode === OPCODE.text) this.fragments = [frame.payload]
      else if (frame.opcode === OPCODE.continuation) this.fragments.push(frame.payload)
      else throw new Error(`unknown opcode ${frame.opcode}`)
      if (!frame.fin) continue
      const text = Buffer.concat(this.fragments).toString('utf8')
      this.fragments = []
      done.push({ opcode: OPCODE.text, text })
    }
  }

  private read(): { opcode: number; payload: Buffer; fin: boolean } | undefined {
    const buffer = this.buffer
    if (buffer.length < 2) return undefined
    const first = buffer[0]!
    const second = buffer[1]!
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    if (masked !== this.masked) {
      throw new Error(this.masked ? 'an unmasked frame from a client' : 'a masked frame from the server')
    }
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return undefined
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return undefined
      const big = buffer.readBigUInt64BE(offset)
      if (big > BigInt(MAX_PAYLOAD)) throw new Error('a frame larger than 1 MiB')
      length = Number(big)
      offset += 8
    }
    if (length > MAX_PAYLOAD) throw new Error('a frame larger than 1 MiB')
    const maskOffset = offset
    if (masked) offset += 4
    if (buffer.length < offset + length) return undefined
    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    if (masked) {
      const key = buffer.subarray(maskOffset, maskOffset + 4)
      for (let index = 0; index < payload.length; index++) payload[index] = payload[index]! ^ key[index & 3]!
    }
    this.buffer = buffer.subarray(offset + length)
    return { opcode, payload, fin }
  }
}

/** One frame as it goes on the wire. A client masks; a server does not. */
export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const length = payload.length
  const extra = length < 126 ? 0 : length < 65_536 ? 2 : 8
  const header = Buffer.alloc(2 + extra + (mask ? 4 : 0))
  header[0] = 0x80 | opcode
  if (extra === 0) header[1] = (mask ? 0x80 : 0) | length
  else if (extra === 2) {
    header[1] = (mask ? 0x80 : 0) | 126
    header.writeUInt16BE(length, 2)
  } else {
    header[1] = (mask ? 0x80 : 0) | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  if (!mask) return Buffer.concat([header, payload])
  const key = randomBytes(4)
  key.copy(header, 2 + extra)
  const bytes = Buffer.from(payload)
  for (let index = 0; index < bytes.length; index++) bytes[index] = bytes[index]! ^ key[index & 3]!
  return Buffer.concat([header, bytes])
}

/** Which end of the wire this peer is: a client masks what it sends, a server does not. */
export type Side = 'client' | 'server'

/** A connected peer: send text, close it, and be told about messages and closure. */
export class Peer {
  private readonly reader: FrameReader
  private messageHandler: (text: string) => void = () => {}
  private closeHandler: () => void = () => {}
  private closed = false

  constructor(
    private readonly socket: Duplex,
    private readonly side: Side,
  ) {
    this.reader = new FrameReader(side === 'server')
    socket.on('data', (chunk: Buffer) => this.receive(chunk))
    socket.on('error', () => this.finish())
    socket.on('close', () => this.finish())
  }

  onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler
  }

  send(text: string): void {
    if (this.closed) return
    this.socket.write(encodeFrame(OPCODE.text, Buffer.from(text, 'utf8'), this.side === 'client'))
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.closed = true
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
    payload.writeUInt16BE(code, 0)
    payload.write(reason, 2)
    try {
      this.socket.write(encodeFrame(OPCODE.close, payload, this.side === 'client'))
    } catch {
      // Already gone; ending the socket below is all that is left.
    }
    this.socket.end()
    this.closeHandler()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.closeHandler()
  }

  private receive(chunk: Buffer): void {
    let frames: Array<{ opcode: number; text?: string }>
    try {
      frames = this.reader.push(chunk)
    } catch {
      this.close(1002, 'protocol error')
      return
    }
    for (const frame of frames) {
      if (frame.opcode === OPCODE.text && frame.text !== undefined) this.messageHandler(frame.text)
      else if (frame.opcode === OPCODE.ping) this.socket.write(encodeFrame(OPCODE.pong, Buffer.alloc(0), this.side === 'client'))
      else if (frame.opcode === OPCODE.close) this.close(1000)
    }
  }
}

/** Completes the server side of the handshake, or answers 400 and returns undefined. */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Peer | undefined {
  const key = req.headers['sec-websocket-key']
  const version = req.headers['sec-websocket-version']
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase()
  if (upgrade !== 'websocket' || version !== '13' || typeof key !== 'string' || !/^[A-Za-z0-9+/=]{20,}$/u.test(key)) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    return undefined
  }
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '',
      '',
    ].join('\r\n'),
  )
  const peer = new Peer(socket, 'server')
  if (head.length > 0) socket.emit('data', head)
  return peer
}

/** Opens the client side of the handshake. Rejects when the host refuses or does not answer. */
export function connect(url: string, timeoutMs = 10_000): Promise<Peer> {
  const target = new URL(url)
  const secure = target.protocol === 'wss:'
  const key = randomBytes(16).toString('base64')
  const send = secure ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const request = send({
      hostname: target.hostname,
      port: target.port === '' ? (secure ? 443 : 80) : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    })
    request.on('timeout', () => request.destroy(new Error(`no answer from ${url} in ${timeoutMs}ms`)))
    request.on('error', reject)
    request.on('response', (response) => {
      response.resume()
      reject(new Error(`${url} refused the upgrade (HTTP ${response.statusCode ?? 0})`))
    })
    request.on('upgrade', (response, socket, head) => {
      if (response.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy()
        reject(new Error('the host did not prove it speaks WebSocket'))
        return
      }
      const peer = new Peer(socket, 'client')
      if (head.length > 0) socket.emit('data', head)
      resolve(peer)
    })
    request.end()
  })
}
