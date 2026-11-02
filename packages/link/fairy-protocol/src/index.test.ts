import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encode, MAX_TEXT, parseClient, parseHost, PROTOCOL_VERSION, type ClientMessage, type HostMessage } from './index.js'

const hello = { type: 'hello', id: 'r1', protocol: PROTOCOL_VERSION, token: 'tok', device: { name: '主人的手机', kind: 'app' } }

function client(frame: unknown) {
  return parseClient(JSON.stringify(frame))
}

function host(frame: unknown) {
  return parseHost(JSON.stringify(frame))
}

test('a paired device introduces itself with the version it speaks', () => {
  const parsed = client(hello)
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.deepEqual(parsed.message, hello)
})

test('a device on another protocol is refused, so it can say so instead of misreading frames', () => {
  const parsed = client({ ...hello, protocol: PROTOCOL_VERSION + 1 })
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.equal(parsed.code, 'wrong-version')
})

test('hello needs a token, a device name and a known kind', () => {
  for (const broken of [
    { ...hello, token: '' },
    { ...hello, device: { name: '  ', kind: 'app' } },
    { ...hello, device: { name: 'x', kind: 'toaster' } },
    { ...hello, device: { name: 'x'.repeat(65), kind: 'app' } },
    { ...hello, accepts: ['push', 'telepathy'] },
  ]) {
    assert.equal(client(broken).ok, false, JSON.stringify(broken))
  }
})

test('what the owner says is bounded, and empty words are not a message', () => {
  assert.equal(client({ type: 'say', id: 'r2', text: '   ' }).ok, false)
  assert.equal(client({ type: 'say', id: 'r2', text: 'x'.repeat(MAX_TEXT) }).ok, true)
  const tooLong = client({ type: 'say', id: 'r2', text: 'x'.repeat(MAX_TEXT + 1) })
  assert.equal(tooLong.ok, false)
  if (!tooLong.ok) assert.equal(tooLong.code, 'too-long')
})

test('an answer must name the confirmation and say yes or no, not "maybe"', () => {
  assert.equal(client({ type: 'answer', id: 'r3', confirm: 'c1', allow: true }).ok, true)
  assert.equal(client({ type: 'answer', id: 'r3', confirm: 'c1' }).ok, false)
  assert.equal(client({ type: 'answer', id: 'r3', confirm: 'c1', allow: 1 }).ok, false)
})

test('every request frame needs its own id, and unknown types are refused by name', () => {
  assert.equal(client({ type: 'status' }).ok, false)
  const unknown = client({ type: 'reboot', id: 'r4' })
  assert.equal(unknown.ok, false)
  if (!unknown.ok) {
    assert.equal(unknown.code, 'unknown-type')
    assert.match(unknown.reason, /reboot/)
  }
})

test('a frame that is not JSON, or not an object, is refused without throwing', () => {
  const torn = parseClient('{"type":"say",')
  assert.equal(torn.ok, false)
  if (!torn.ok) assert.equal(torn.code, 'bad-json')
  assert.equal(parseClient('[]').ok, false)
  assert.equal(parseClient('null').ok, false)
  assert.equal(parseClient('42').ok, false)
})

test('sessions lists or selects, and selecting needs a session to select', () => {
  assert.equal(client({ type: 'sessions', id: 'r5', action: 'list' }).ok, true)
  assert.equal(client({ type: 'sessions', id: 'r5', action: 'use', sessionId: 's-1' }).ok, true)
  assert.equal(client({ type: 'sessions', id: 'r5', action: 'use' }).ok, false)
  assert.equal(client({ type: 'sessions', id: 'r5', action: 'drop' }).ok, false)
})

test('the host welcomes a device and answers in frames the client can validate', () => {
  const welcome = host({ type: 'welcome', id: 'r1', name: 'Fairy', protocol: PROTOCOL_VERSION, sessionId: 's-1' })
  assert.equal(welcome.ok, true)
  assert.equal(host({ type: 'welcome', id: 'r1', name: 'Fairy', protocol: 99 }).ok, false, 'a client on another version must notice')

  assert.equal(host({ type: 'reply.delta', id: 'r1', turn: 't1', text: '嗯' }).ok, true)
  assert.equal(host({ type: 'reply.done', id: 'r1', turn: 't1', text: '' }).ok, true)
  assert.equal(host({ type: 'reply.done', id: 'r1', text: '' }).ok, false, 'a delta without its turn cannot be placed')
})

test('an urge carries why she speaks and about what', () => {
  assert.equal(host({ type: 'urge', id: 'u1', why: 'missed', about: '两天没听他说话了' }).ok, true)
  assert.equal(host({ type: 'urge', id: 'u1', why: 'bored', about: 'x' }).ok, false)
  assert.equal(host({ type: 'urge', id: 'u1', why: 'share' }).ok, false)
})

test('a confirmation shows what is being asked and why, and nothing that is not words', () => {
  const confirm = { type: 'confirm', id: 'c1', tool: 'pwsh', why: ['删除文件或文件夹'], subject: 'Remove-Item -Recurse C:\\tmp\\x' }
  assert.equal(host(confirm).ok, true)
  assert.equal(host({ ...confirm, why: 'delete' }).ok, false)
  assert.equal(host({ ...confirm, subject: '' }).ok, false)
})

test('status and recall answers are checked down to their fields', () => {
  assert.equal(host({ type: 'status', id: 'r6', status: { at: 0, asleep: false, mood: 0.2, energy: 0.8 } }).ok, true)
  assert.equal(host({ type: 'status', id: 'r6', status: { at: 0, asleep: 'no', mood: 0.2, energy: 0.8 } }).ok, false)
  assert.equal(
    host({ type: 'recall', id: 'r7', query: '花生', memories: [{ id: 'e9', clarity: 'clear', at: 0, text: '主人对花生过敏' }] }).ok,
    true,
  )
  assert.equal(host({ type: 'recall', id: 'r7', query: '花生', memories: [{ id: 'e9', clarity: 'vivid', at: 0, text: 'x' }] }).ok, false)
})

test('a failure names the request it answers, when it has one', () => {
  assert.equal(host({ type: 'error', code: 'bad-shape', message: 'nope' }).ok, true)
  assert.equal(host({ type: 'error', id: 'r1', code: 'bad-shape', message: 'nope' }).ok, true)
  assert.equal(host({ type: 'error', message: 'nope' }).ok, false)
})

test('what the host writes is exactly what the other side reads', () => {
  const messages: Array<ClientMessage | HostMessage> = [
    hello as unknown as ClientMessage,
    { type: 'welcome', id: 'r1', name: 'Fairy', protocol: PROTOCOL_VERSION },
    { type: 'reply.delta', id: 'r1', turn: 't1', text: '一半' },
    { type: 'error', id: 'r1', code: 'unknown-type', message: 'nope' },
  ]
  for (const message of messages) {
    const raw = encode(message)
    const parsed = message.type === 'hello' ? parseClient(raw) : parseHost(raw)
    assert.equal(parsed.ok, true, raw)
  }
})
