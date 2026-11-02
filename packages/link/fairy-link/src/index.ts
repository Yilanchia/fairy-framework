/**
 * `@fairy/link` — Fairy's channel to her devices.
 *
 * What is here so far is the part that has to be right before any socket opens: the devices the
 * owner has paired (tokens kept only as hashes) and the one live pairing code. The WebSocket that
 * carries the owner's words and her confirmations is built on top of these next.
 */
export { DeviceStore, type Device, type Paired } from './devices.js'
export { PairingCodes } from './pairing.js'
