import { timingSafeEqual } from 'node:crypto'

/**
 * One pairing code at a time: minted on the host, read off the console by the owner, typed into
 * the device they are pairing, and dead the moment it is used or the window closes.
 *
 * A six-digit code is only safe behind two other gates, and both are the host's: pairing is offered
 * only on the address the owner reaches, and repeated wrong codes are slowed down by the caller.
 */
export class PairingCodes {
  private current: { code: string; expiresAt: number } | undefined

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Mints a new code, replacing any unused one: two live codes would double the guessing surface. */
  mint(): { code: string; expiresAt: number } {
    const code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')
    this.current = { code, expiresAt: this.now() + this.ttlMs }
    return this.current
  }

  /** The live code, if it has not expired; expired codes are dropped rather than kept around. */
  peek(): { code: string; expiresAt: number } | undefined {
    if (this.current && this.current.expiresAt <= this.now()) this.current = undefined
    return this.current
  }

  /** Uses the code up. A wrong or expired code changes nothing. */
  redeem(code: string): boolean {
    const live = this.peek()
    if (!live) return false
    const given = Buffer.from(String(code).trim().padEnd(6, ' '), 'utf8')
    const wanted = Buffer.from(live.code.padEnd(6, ' '), 'utf8')
    if (!timingSafeEqual(given, wanted)) return false
    this.current = undefined
    return true
  }
}
