import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DeviceKind } from '@fairy/protocol'

/**
 * The devices the owner has paired, and nothing else: one small JSON file beside her life.
 *
 * A token is minted once, given to the device that earned it, and never written down: the file
 * keeps only its SHA-256, so a copy of the file cannot be replayed as a device. Revoking is
 * dropping the row.
 */
export interface Device {
  readonly id: string
  readonly name: string
  readonly kind: DeviceKind
  readonly createdAt: number
  readonly lastSeenAt: number
  /** SHA-256 of the token, hex. The token itself is never stored. */
  readonly tokenHash: string
}

/** What the owner gets handed once, at pairing time. */
export interface Paired {
  readonly device: Device
  /** The only copy of this string: it is not recoverable from the file. */
  readonly token: string
}

function hash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Compares two hex digests without leaking where they differ. */
function same(left: string, right: string): boolean {
  if (left.length !== right.length) return false
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

export class DeviceStore {
  private constructor(
    private readonly path: string,
    private devices: Device[],
  ) {}

  /** Reads the file, or starts empty when there is none. A file that is not devices is an error. */
  static open(path: string): DeviceStore {
    if (!existsSync(path)) return new DeviceStore(path, [])
    const text = readFileSync(path, 'utf8')
    let rows: unknown
    try {
      rows = JSON.parse(text)
    } catch (error) {
      throw new Error(`${path} is not a devices file`, { cause: error })
    }
    if (!Array.isArray(rows)) throw new Error(`${path} is not a devices file`)
    const devices: Device[] = []
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) throw new Error(`${path} holds a row that is not a device`)
      const device = row as Record<string, unknown>
      if (typeof device.id !== 'string' || typeof device.tokenHash !== 'string' || typeof device.name !== 'string') {
        throw new Error(`${path} holds a row that is not a device`)
      }
      devices.push({
        id: device.id,
        name: device.name,
        kind: device.kind === 'node' || device.kind === 'cli' ? device.kind : 'app',
        createdAt: typeof device.createdAt === 'number' ? device.createdAt : 0,
        lastSeenAt: typeof device.lastSeenAt === 'number' ? device.lastSeenAt : 0,
        tokenHash: device.tokenHash,
      })
    }
    return new DeviceStore(path, devices)
  }

  /** Pairs one device: mints its token, keeps only the hash, and returns both once. */
  add(name: string, kind: DeviceKind, now = Date.now()): Paired {
    const token = randomBytes(32).toString('base64url')
    const device: Device = {
      id: randomBytes(9).toString('base64url'),
      name,
      kind,
      createdAt: now,
      lastSeenAt: now,
      tokenHash: hash(token),
    }
    this.devices.push(device)
    this.save()
    return { device, token }
  }

  /** The device this token belongs to, or undefined. Says nothing about which half was wrong. */
  authenticate(token: string): Device | undefined {
    const wanted = hash(token)
    return this.devices.find((device) => same(device.tokenHash, wanted))
  }

  /** Notes that a device was just seen; the file is written at most once a minute per device. */
  touch(id: string, now = Date.now()): void {
    const device = this.devices.find((row) => row.id === id)
    if (!device) return
    if (now - device.lastSeenAt < 60_000) return
    const updated: Device = { ...device, lastSeenAt: now }
    this.devices = this.devices.map((row) => (row.id === id ? updated : row))
    this.save()
  }

  /** Forgets a device: its token stops working immediately. */
  revoke(id: string): boolean {
    const before = this.devices.length
    this.devices = this.devices.filter((device) => device.id !== id)
    if (this.devices.length === before) return false
    this.save()
    return true
  }

  /** Every paired device, oldest first. */
  list(): readonly Device[] {
    return [...this.devices].sort((left, right) => left.createdAt - right.createdAt)
  }

  /** Written whole, then renamed over the old file, so a crash leaves one complete file. */
  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.devices, null, 2)}\n`, 'utf8')
    renameSync(temporary, this.path)
  }
}
