import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * The code the owner types into a device to pair it.
 *
 * Two modes:
 * - rotating (default): a six-digit code that lives five minutes and is used up by the first
 *   device that redeems it. Right for a host with a console someone is watching.
 * - fixed: one long code the owner keeps, because fetching a fresh six-digit number for every new
 *   phone is friction he will not accept. Fixed means guessable forever, so the caller enforces a
 *   minimum length and must slow down repeated failures.
 *
 * Either way the code is only one of two locks: the device still gets a 32-byte token that is
 * stored as a hash and can be revoked.
 */
export class PairingCodes {
  private current: { code: string; expiresAt: number } | undefined

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly now: () => number = Date.now,
    /** Set for a fixed code; `expiresAt` is then 0, meaning "no expiry". */
    private readonly fixed?: string,
  ) {
    if (fixed !== undefined) this.current = { code: fixed, expiresAt: 0 }
  }

  /** Whether this code never expires and is not used up. */
  get isFixed(): boolean {
    return this.fixed !== undefined
  }

  /** Mints a new code, replacing any unused one: two live codes would double the guessing surface. */
  mint(): { code: string; expiresAt: number } {
    if (this.fixed !== undefined) {
      this.current = { code: this.fixed, expiresAt: 0 }
      return this.current
    }
    const code = randomBytes(4).readUInt32BE(0) % 1_000_000
    this.current = { code: String(code).padStart(6, '0'), expiresAt: this.now() + this.ttlMs }
    return this.current
  }

  /** The live code, if it has not expired; expired codes are dropped rather than kept around. */
  peek(): { code: string; expiresAt: number } | undefined {
    // expiresAt 0 means a fixed code: nothing to expire.
    if (this.current && this.current.expiresAt !== 0 && this.current.expiresAt <= this.now()) this.current = undefined
    return this.current
  }

  /** Uses the code up, or matches a fixed one without consuming it. A wrong code changes nothing. */
  redeem(code: string): boolean {
    const live = this.peek()
    if (!live) return false
    const given = createHash('sha256').update(String(code).trim(), 'utf8').digest()
    const wanted = createHash('sha256').update(live.code, 'utf8').digest()
    if (!timingSafeEqual(given, wanted)) return false
    if (!this.isFixed) this.current = undefined
    return true
  }
}
