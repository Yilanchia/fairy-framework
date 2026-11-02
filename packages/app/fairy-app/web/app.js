// Fairy's page. One file, no framework, no build step: the only shared code is the protocol
// package the host serves beside it. Everything the host sends is rendered with textContent, so
// nothing she or the owner types can become markup.
import { encode, parseHost, PROTOCOL_VERSION } from './protocol.js'

const KEY_TOKEN = 'fairy-app:token'
const KEY_NAME = 'fairy-app:name'

const $ = (id) => document.getElementById(id)
const state = {
  socket: undefined,
  token: localStorage.getItem(KEY_TOKEN),
  name: localStorage.getItem(KEY_NAME) ?? '我的设备',
  retry: 0,
  timer: undefined,
  /** Set when a history reply is on its way, so it replaces the log instead of appending. */
  awaitingHistory: false,
}

function setState(text, bad = false) {
  const el = $('state')
  el.textContent = text
  el.classList.toggle('bad', bad)
}

function show(which) {
  $('pair').classList.toggle('show', which === 'pair')
  $('log').classList.toggle('hidden', which !== 'chat')
  $('composer').classList.toggle('hidden', which !== 'chat')
}

function line(kind, text) {
  const row = document.createElement('div')
  row.className = kind === 'note' ? 'note' : `row ${kind}`
  if (text) {
    const words = document.createElement('span')
    words.textContent = text
    row.append(words)
  }
  $('log').append(row)
  $('log').scrollTop = $('log').scrollHeight
  return row
}

function picture(row, mediaType, data) {
  const image = document.createElement('img')
  image.src = `data:${mediaType};base64,${data}`
  image.alt = '图片'
  image.loading = 'lazy'
  row.append(image)
}

function socketUrl() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/fairy/link/v1`
}

/** Sends a frame if the socket is up; says so instead of pretending when it is not. */
function send(frame) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    line('note', '还没连上她，等一下再发。')
    return false
  }
  state.socket.send(encode(frame))
  return true
}

function connect() {
  clearTimeout(state.timer)
  if (!state.token) return show('pair')
  show('chat')
  setState('连接中…')
  const socket = new WebSocket(socketUrl())
  state.socket = socket

  socket.addEventListener('open', () => {
    socket.send(
      encode({
        type: 'hello',
        id: `hello-${crypto.randomUUID()}`,
        protocol: PROTOCOL_VERSION,
        token: state.token,
        device: { name: state.name, kind: 'app' },
        accepts: ['push', 'confirm'],
      }),
    )
  })

  socket.addEventListener('message', (event) => {
    let parsed
    try {
      parsed = parseHost(event.data)
    } catch {
      return
    }
    if (!parsed.ok) return
    const message = parsed.message
    switch (message.type) {
      case 'welcome':
        state.retry = 0
        setState(`连着 ${message.name}`)
        // What was said before, so opening the page is not a blank room.
        state.awaitingHistory = true
        send({ type: 'history', id: `history-${crypto.randomUUID()}`, limit: 60 })
        break
      case 'history':
        if (state.awaitingHistory) {
          $('log').textContent = ''
          state.awaitingHistory = false
        }
        for (const entry of message.lines) line(entry.who === 'owner' ? 'me' : 'her', entry.text)
        if (message.lines.length === 0) line('note', '这里还没有说过话。')
        break
      case 'reply.done':
      case 'reply.delta':
        // Only whole replies are sent today; both are rendered the same way.
        line('her', message.text)
        break
      case 'urge':
        line('note', `她主动找你：${message.about}`)
        break
      case 'confirm':
        line('note', `她需要你点头：${message.question}`)
        break
      case 'error':
        if (/token|pair/i.test(message.message)) {
          localStorage.removeItem(KEY_TOKEN)
          state.token = undefined
          show('pair')
          setState('配对失效了，重新配一次', true)
        } else {
          line('note', `出错了：${message.message}`)
        }
        break
      default:
        break
    }
  })

  socket.addEventListener('close', () => {
    if (socket !== state.socket) return
    state.socket = undefined
    setState('断线了，正在重连…', true)
    state.retry = Math.min(state.retry + 1, 6)
    state.timer = setTimeout(connect, Math.min(1000 * 2 ** (state.retry - 1), 30_000))
  })

  socket.addEventListener('error', () => setState('连不上她', true))
}

async function pair() {
  const code = $('code').value.trim()
  const name = $('name').value.trim() || '我的设备'
  const error = $('pairError')
  error.classList.add('hidden')
  // The host decides what a valid code is: six digits that rotate, or a long fixed one the owner
  // keeps. The page only refuses an empty box.
  if (!code || code.length > 128) {
    error.textContent = '配对码没填。'
    error.classList.remove('hidden')
    return
  }
  $('pairButton').disabled = true
  try {
    const response = await fetch('/fairy/link/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name, kind: 'app' }),
    })
    const answer = await response.json()
    if (!response.ok || !answer.token) throw new Error(answer.error ?? `HTTP ${response.status}`)
    localStorage.setItem(KEY_TOKEN, answer.token)
    localStorage.setItem(KEY_NAME, name)
    state.token = answer.token
    state.name = name
    connect()
  } catch (problem) {
    error.textContent = problem instanceof Error ? problem.message : String(problem)
    error.classList.remove('hidden')
  } finally {
    $('pairButton').disabled = false
  }
}

function say() {
  const text = $('text').value.trim()
  if (!text) return
  if (!send({ type: 'say', id: `say-${crypto.randomUUID()}`, text })) return
  line('me', text)
  $('text').value = ''
}

/**
 * A phone photo is several megabytes; one frame is not. Downscale to a long edge of 1280 and
 * re-encode as JPEG, which lands around 200–400 KB and still shows her everything she needs.
 */
async function shrink(file) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close?.()
  const url = canvas.toDataURL('image/jpeg', 0.72)
  return { mediaType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), name: file.name || 'photo.jpg', preview: url }
}

async function attach() {
  const files = [...($('file').files ?? [])].slice(0, 4)
  $('file').value = ''
  if (files.length === 0) return
  const text = $('text').value.trim()
  try {
    const images = []
    for (const file of files) images.push(await shrink(file))
    if (!send({ type: 'say', id: `say-${crypto.randomUUID()}`, text, images: images.map(({ mediaType, data, name }) => ({ mediaType, data, name })) })) return
    const row = line('me', text)
    for (const image of images) picture(row, image.mediaType, image.data)
    $('text').value = ''
  } catch (problem) {
    line('note', `这张图发不出去：${problem instanceof Error ? problem.message : String(problem)}`)
  }
}

$('pairButton').addEventListener('click', pair)
$('code').addEventListener('keydown', (event) => event.key === 'Enter' && pair())
$('send').addEventListener('click', say)
$('text').addEventListener('keydown', (event) => event.key === 'Enter' && say())
$('attach').addEventListener('click', () => $('file').click())
$('file').addEventListener('change', attach)
$('name').value = state.name

if (state.token) connect()
else show('pair')
