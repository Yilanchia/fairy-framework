import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PairingCodes } from './pairing.js'

test('the code the owner reads out works once and then never again', () => {
  const codes = new PairingCodes(300_000, () => 0)
  const { code } = codes.mint()
  assert.match(code, /^\d{6}$/)
  assert.equal(codes.redeem(code), true)
  assert.equal(codes.redeem(code), false, 'a used code is dead')
  assert.equal(codes.peek(), undefined)
})

test('an expired code cannot be used, and a wrong one does not burn the live one', () => {
  let now = 0
  const codes = new PairingCodes(300_000, () => now)
  const { code, expiresAt } = codes.mint()
  assert.equal(codes.redeem('000000' === code ? '111111' : '000000'), false)
  assert.equal(codes.redeem(code), true, 'the wrong guess left the real code alive')

  const second = codes.mint()
  now = expiresAt + 1
  assert.equal(codes.peek(), undefined)
  assert.equal(codes.redeem(second.code), false, 'expired')
})

test('minting again replaces the old code, so only one is ever live', () => {
  const codes = new PairingCodes(300_000, () => 0)
  const first = codes.mint()
  const second = codes.mint()
  assert.notEqual(first.code, second.code)
  assert.equal(codes.redeem(first.code), false)
  assert.equal(codes.redeem(second.code), true)
})
