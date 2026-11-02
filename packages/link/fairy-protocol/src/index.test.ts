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

test('a picture may ride along, or make a message on its own, but never unbounded', () => {
  const png = Buffer.from('x'.repeat(64)).toString('base64')
  assert.equal(client({ type: 'say', id: 's1', text: '看', images: [{ mediaType: 'image/png', data: png }] }).ok, true)
  assert.equal(client({ type: 'say', id: 's2', text: '', images: [{ mediaType: 'image/jpeg', data: png }] }).ok, true, 'a photo needs no caption')
  assert.equal(client({ type: 'say', id: 's3', text: '' }).ok, false, 'but empty means nothing at all')
  assert.equal(client({ type: 'say', id: 's4', text: 'x', images: [{ mediaType: 'image/gif', data: png }] }).ok, false)
  assert.equal(client({ type: 'say', id: 's5', text: 'x', images: [{ mediaType: 'image/png', data: 'data:image/png;base64,AAA' }] }).ok, false)
  assert.equal(client({ type: 'say', id: 's6', text: 'x', images: [] }).ok, false)
  const many = Array.from({ length: 5 }, () => ({ mediaType: 'image/png', data: png }))
  assert.equal(client({ type: 'say', id: 's7', text: 'x', images: many }).ok, false, 'at most four pictures')
})

test('a text file may ride along, and is bounded like everything else', () => {
  assert.equal(client({ type: 'say', id: 'd1', text: '', document: { name: 'a.md', text: '# hi' } }).ok, true)
  assert.equal(client({ type: 'say', id: 'd2', text: '看看这个', document: { name: 'a.md', text: '# hi' } }).ok, true)
  assert.equal(client({ type: 'say', id: 'd3', text: 'x', document: { name: '', text: 'x' } }).ok, false)
  assert.equal(client({ type: 'say', id: 'd4', text: 'x', document: { name: 'a.md', text: '   ' } }).ok, false)
  assert.equal(client({ type: 'say', id: 'd5', text: 'x', document: { name: 'a.md', text: 'x'.repeat(40_001) } }).ok, false)
  assert.equal(client({ type: 'say', id: 'd6', text: 'x', document: { name: 'x'.repeat(121), text: 'x' } }).ok, false)
})

test('history asks for words already said, and the answer is checked like everything else', () => {
  assert.equal(client({ type: 'history', id: 'h1' }).ok, true)
  assert.equal(client({ type: 'history', id: 'h2', limit: 20 }).ok, true)
  assert.equal(client({ type: 'history', id: 'h3', limit: 0 }).ok, false)
  assert.equal(
    host({ type: 'history', id: 'h1', lines: [{ id: 'e1', at: 0, who: 'owner', text: '在吗' }, { id: 'e2', at: 1, who: 'fairy', text: '在。' }] }).ok,
    true,
  )
  assert.equal(host({ type: 'history', id: 'h1', lines: [{ id: 'e1', at: 0, who: 'nobody', text: 'x' }] }).ok, false)
  assert.equal(host({ type: 'history', id: 'h1', lines: [{ id: 'e1', at: 0, who: 'owner' }] }).ok, false)
})

test('what the owner says is bounded, and empty words are not a message', () => {
  assert.equal(client({ type: 'say', id: 'r2', text: '   ' }).ok, false)
  assert.equal(client({ type: 'say', id: 'r2', text: 'x'.repeat(MAX_TEXT) }).ok, true)
  const tooLong = client({ type: 'say', id: 'r2', text: 'x'.repeat(MAX_TEXT + 1) })
  assert.equal(tooLong.ok, false)
  if (!tooLong.ok) assert.equal(tooLong.code, 'too-long')
})

test('an answer names the confirmation and the labels the owner picked', () => {
  assert.equal(client({ type: 'answer', id: 'r3', confirm: 'c1', selected: ['不允许'] }).ok, true)
  assert.equal(client({ type: 'answer', id: 'r3', confirm: 'c1', selected: [] }).ok, true, 'dismissing is an answer too')
  assert.equal(client({ type: 'answer', id: 'r3', confirm: 'c1' }).ok, false)
  assert.equal(client({ type: 'answer', id: 'r3', confirm: 'c1', selected: [1] }).ok, false)
  assert.equal(client({ type: 'answer', id: 'r3', confirm: 'c1', selected: ['x'], custom: '原因是…' }).ok, true)
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

test('a confirmation carries the question and the choices, so any question can be shown', () => {
  const confirm = {
    type: 'confirm',
    id: 'c1',
    tool: 'pwsh',
    question: '删除或不可撤销：删除文件或文件夹。要让她做吗？',
    why: ['删除文件或文件夹'],
    options: [{ label: '允许这一次' }, { label: '不允许', description: '她会收到“主人没有同意”。' }],
  }
  assert.equal(host(confirm).ok, true)
  assert.equal(host({ ...confirm, why: 'delete' }).ok, false)
  assert.equal(host({ ...confirm, options: [] }).ok, false, 'a question with no choices cannot be answered')
  assert.equal(host({ ...confirm, options: [{ label: ' ' }] }).ok, false)
  assert.equal(host({ ...confirm, question: '' }).ok, false)
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
