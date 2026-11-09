import { createHash } from 'node:crypto'
import type { Fact } from './types.js'

/**
 * Pure parsers: the only place a command's raw text becomes facts. They never run anything,
 * so every one of them is testable without a machine or a process.
 */

/** SHA-256 of a raw read, so the same output can be checked without keeping it all. */
export function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Merge facts that share a key (one port listened on two addresses, say) into one line. */
export function dedupe(facts: readonly Fact[]): Fact[] {
  const byKey = new Map<string, { value: string[]; detail?: string }>()
  for (const fact of facts) {
    const current = byKey.get(fact.key)
    if (!current) {
      byKey.set(fact.key, { value: [fact.value], ...(fact.detail ? { detail: fact.detail } : {}) })
      continue
    }
    if (!current.value.includes(fact.value)) current.value.push(fact.value)
    if (!current.detail && fact.detail) current.detail = fact.detail
  }
  return [...byKey.entries()]
    .map(([key, merged]) => ({ kind: facts.find((fact) => fact.key === key)?.kind ?? 'fact', key, value: merged.value.join(' | '), ...(merged.detail ? { detail: merged.detail } : {}) }))
    .sort((left, right) => left.key.localeCompare(right.key))
}

/** One listening socket, as `ss` or `Get-NetTCPConnection` reports it. */
export interface ListenSocket {
  address: string
  port: number
  process?: string
  pid?: number
}

/**
 * `ss -ltnp`. The columns are State Recv-Q Send-Q Local Peer Process; the local address is the
 * fourth field and may be `0.0.0.0:22`, `[::]:80` or `*:3306`.
 */
export function parseSsListen(output: string): ListenSocket[] {
  const sockets: ListenSocket[] = []
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields[0] !== 'LISTEN' || fields.length < 4) continue
    const local = fields[3]!
    const match = /^(.*):(\d+)$/.exec(local)
    if (!match) continue
    const port = Number(match[2])
    if (!Number.isInteger(port) || port <= 0) continue
    const process = /users:\(\("([^"]+)"/.exec(line)?.[1]
    const pid = /pid=(\d+)/.exec(line)?.[1]
    sockets.push({
      address: match[1]!,
      port,
      ...(process ? { process } : {}),
      ...(pid ? { pid: Number(pid) } : {}),
    })
  }
  return sockets.sort((left, right) => left.port - right.port || left.address.localeCompare(right.address))
}

/** One listening socket from `Get-NetTCPConnection -State Listen | ConvertTo-Json -Compress`. */
interface WindowsListenRow {
  LocalAddress?: unknown
  LocalPort?: unknown
  OwningProcess?: unknown
}

export function parseWindowsListen(json: string): ListenSocket[] {
  let rows: unknown
  try {
    rows = JSON.parse(json)
  } catch {
    return []
  }
  const list = Array.isArray(rows) ? rows : [rows]
  const sockets: ListenSocket[] = []
  for (const candidate of list) {
    if (!candidate || typeof candidate !== 'object') continue
    const row = candidate as WindowsListenRow
    const address = typeof row.LocalAddress === 'string' ? row.LocalAddress : undefined
    const port = typeof row.LocalPort === 'number' ? row.LocalPort : Number(row.LocalPort)
    if (!address || !Number.isInteger(port) || port <= 0) continue
    const pid = typeof row.OwningProcess === 'number' ? row.OwningProcess : Number(row.OwningProcess)
    sockets.push({ address, port, ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}) })
  }
  return sockets.sort((left, right) => left.port - right.port || left.address.localeCompare(right.address))
}

/** Listening sockets as facts: one per port, addresses merged. */
export function listenFacts(sockets: readonly ListenSocket[]): Fact[] {
  return dedupe(
    sockets.map((socket) => ({
      kind: 'listen_port',
      key: `tcp:${socket.port}`,
      value: `${socket.address}:${socket.port}${socket.process ? ` (${socket.process}${socket.pid ? `, pid ${socket.pid}` : ''})` : socket.pid ? ` (pid ${socket.pid})` : ''}`,
      detail: `${socket.address}:${socket.port}`,
    })),
  )
}

/** The sshd options worth knowing about, as facts. Only the first effective value counts. */
const SSHD_OPTIONS = ['PasswordAuthentication', 'PermitRootLogin', 'PubkeyAuthentication', 'PermitEmptyPasswords'] as const

export function parseSshdConfig(text: string): Fact[] {
  const found = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([A-Za-z]+)\s+(.+)$/.exec(line)
    if (!match) continue
    const name = SSHD_OPTIONS.find((option) => option.toLowerCase() === match[1]!.toLowerCase())
    if (name && !found.has(name)) found.set(name, match[2]!.trim())
  }
  return [...found.entries()]
    .map(([name, value]) => ({
      kind: 'ssh_option',
      key: `ssh:${name.toLowerCase()}`,
      value,
    }))
    .sort((left, right) => left.key.localeCompare(right.key))
}

/**
 * One non-empty, non-comment line per key. The key itself is not secret, but its comment may
 * carry a person's address, so only the algorithm and a fingerprint go in.
 */
export function parseAuthorizedKeys(text: string): Fact[] {
  const facts: Fact[] = []
  let count = 0
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const fields = line.split(/\s+/)
    if (fields.length < 2) continue
    const type = fields[0]!
    const material = fields[1]!
    count += 1
    facts.push({
      kind: 'ssh_authorized_key',
      key: `ssh:authorized_key:${digest(material).slice(0, 12)}`,
      value: type,
    })
  }
  facts.push({ kind: 'ssh_authorized_key_count', key: 'ssh:authorized_keys:count', value: String(count) })
  return dedupe(facts)
}
