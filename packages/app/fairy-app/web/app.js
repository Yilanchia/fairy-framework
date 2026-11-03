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
  awaitingHistory: false,
  pushKey: undefined,
}

function setState(text, bad = false) {
  const el = $('state')
  el.textContent = text
  el.classList.toggle('bad', bad)
}

/** How she is right now, next to the connection state. */
function setDoing(text) {
  $('doing').textContent = text
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

/** A question of hers that needs an answer: the buttons are the whole point of the card. */
function confirmCard(message) {
  const card = document.createElement('div')
  card.className = 'card'
  const head = document.createElement('div')
  head.className = 'card-head'
  head.textContent = message.header ?? '她要动一下手'
  const question = document.createElement('div')
  question.className = 'card-question'
  const words = document.createElement('span')
  words.textContent = message.question
  question.append(words)
  const detail = document.createElement('pre')
  detail.className = 'card-detail'
  detail.textContent = message.detail ?? ''
  detail.hidden = !message.detail
  const actions = document.createElement('div')
  actions.className = 'card-actions'
  for (const option of message.options) {
    const button = document.createElement('button')
    button.textContent = option.label
    button.title = option.description ?? ''
    button.addEventListener('click', () => {
      const sent = send({ type: 'answer', id: `a-${crypto.randomUUID()}`, confirm: message.id, selected: [option.label] })
      for (const other of actions.querySelectorAll('button')) other.disabled = true
      button.classList.add('chosen')
      if (sent) {
        const said = document.createElement('div')
        said.className = 'card-said'
        said.textContent = `已选：${option.label}`
        card.append(said)
      }
    })
    actions.append(button)
  }
  card.append(head, question, detail, actions)
  $('log').append(card)
  $('log').scrollTop = $('log').scrollHeight
}

function socketUrl() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/fairy/link/v1`
}

function send(frame) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    line('note', '还没连上她，等一下再发。')
    return false
  }
  state.socket.send(encode(frame))
  return true
}

/* ── notifications: the only way her words reach a page nobody is looking at ──────────────── */

function urlBase64ToKey(base64) {
  const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`.replace(/-/gu, '+').replace(/_/gu, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index)
  return bytes
}

async function subscribe() {
  if (!state.pushKey || !('serviceWorker' in navigator) || !('PushManager' in window)) return
  if (Notification.permission !== 'granted') return
  try {
    const registration = await navigator.serviceWorker.register('./sw.js')
    const existing = await registration.pushManager.getSubscription()
    const subscription =
      existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToKey(state.pushKey) }))
    const json = subscription.toJSON()
    if (json.endpoint && json.keys) {
      send({ type: 'push', id: `push-${crypto.randomUUID()}`, subscription: { endpoint: json.endpoint, keys: json.keys } })
      $('notify').classList.add('hidden')
    }
  } catch (problem) {
    line('note', `通知没开起来：${problem instanceof Error ? problem.message : String(problem)}`)
  }
}

async function askNotification() {
  if (!('Notification' in window)) return line('note', '这个浏览器不支持通知。iPhone 请先把本页「添加到主屏幕」，再从主屏幕打开。')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return line('note', '没给通知权限。如果之前点过"不允许"，去浏览器的网站设置里把这一个站点改回允许。')
  }
  await subscribe()
  line('note', '通知开了。页面关着的时候，她找你也会响。')
}

/**
 * The entry point to notifications, shown whenever the host can push. It used to appear only when
 * the browser had not been asked yet — so a phone that had once answered "no", or an iPhone Safari
 * tab that cannot push at all, showed nothing and left the owner hunting for a button.
 */
async function offerNotifications() {
  const button = $('notify')
  if (!state.pushKey) {
    button.classList.add('hidden')
    return
  }
  if (!('Notification' in window) || !('PushManager' in window) || !('serviceWorker' in navigator)) {
    // iOS Safari only allows this for a page added to the home screen; say so instead of hiding.
    button.textContent = '通知不可用'
    button.classList.remove('hidden')
    button.disabled = true
    button.title = '这个浏览器不能收推送。iPhone 请先把本页「添加到主屏幕」，再从主屏幕打开。'
    return
  }
  if (Notification.permission === 'granted') {
    button.textContent = '通知已开'
    button.classList.remove('hidden')
    await subscribe()
    button.classList.add('hidden')
    return
  }
  button.textContent = Notification.permission === 'denied' ? '通知被禁用了' : '开启通知'
  button.classList.remove('hidden')
  button.disabled = false
}

/* ── the socket ──────────────────────────────────────────────────────────────────────────── */

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
        state.pushKey = message.pushKey
        state.awaitingHistory = true
        send({ type: 'history', id: `history-${crypto.randomUUID()}`, limit: 60 })
        send({ type: 'status', id: `status-${crypto.randomUUID()}` })
        void offerNotifications()
        break
      case 'history':
        if (state.awaitingHistory) {
          $('log').textContent = ''
          state.awaitingHistory = false
        }
        for (const entry of message.lines) line(entry.who === 'owner' ? 'me' : 'her', entry.text)
        if (message.lines.length === 0) line('note', '这里还没有说过话。')
        break
      case 'status': {
        const doing = message.status.doing ?? ''
        const how = message.status.asleep ? '睡着' : doing ? (doing.startsWith('在') ? doing : `在${doing}`) : '醒着'
        setDoing(`${how} · 精力 ${Math.round(message.status.energy * 100)}%`)
        break
      }
      case 'reply.done':
      case 'reply.delta':
        line('her', message.text)
        break
      case 'urge':
        line('note', `她主动找你：${message.about}`)
        break
      case 'confirm':
        confirmCard(message)
        break
      case 'push.ok':
        line('note', '通知已经挂上了。')
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
    setDoing('')
    state.retry = Math.min(state.retry + 1, 6)
    state.timer = setTimeout(connect, Math.min(1000 * 2 ** (state.retry - 1), 30_000))
  })

  socket.addEventListener('error', () => setState('连不上她', true))
}

/* ── pairing, talking, sending things ───────────────────────────────────────────────────── */

async function pair() {
  const code = $('code').value.trim()
  const name = $('name').value.trim() || '我的设备'
  const error = $('pairError')
  error.classList.add('hidden')
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

async function shrink(file) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close?.()
  const url = canvas.toDataURL('image/jpeg', 0.72)
  return { mediaType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), name: file.name || 'photo.jpg' }
}

async function attach() {
  const files = [...($('file').files ?? [])].slice(0, 4)
  $('file').value = ''
  if (files.length === 0) return
  const text = $('text').value.trim()
  try {
    const images = []
    for (const file of files) images.push(await shrink(file))
    if (!send({ type: 'say', id: `say-${crypto.randomUUID()}`, text, images })) return
    const row = line('me', text)
    for (const image of images) picture(row, image.mediaType, image.data)
    $('text').value = ''
  } catch (problem) {
    line('note', `这张图发不出去：${problem instanceof Error ? problem.message : String(problem)}`)
  }
}

async function sendDocument() {
  const file = $('doc').files?.[0]
  $('doc').value = ''
  if (!file) return
  const text = await file.text()
  if (!text.trim()) return line('note', '这个文件是空的。')
  if (text.length > 40000) return line('note', `文件太长（${text.length} 字），现在的上限是 4 万字。`)
  const caption = $('text').value.trim()
  if (!send({ type: 'say', id: `say-${crypto.randomUUID()}`, text: caption, document: { name: file.name, text } })) return
  line('me', `${caption ? `${caption}\n\n` : ''}📄 ${file.name}（${text.length} 字）`)
  $('text').value = ''
}

$('pairButton').addEventListener('click', pair)
$('code').addEventListener('keydown', (event) => event.key === 'Enter' && pair())
$('send').addEventListener('click', say)
$('text').addEventListener('keydown', (event) => event.key === 'Enter' && say())
$('attach').addEventListener('click', () => $('file').click())
$('file').addEventListener('change', attach)
$('sendFile').addEventListener('click', () => $('doc').click())
$('doc').addEventListener('change', sendDocument)
$('notify').addEventListener('click', askNotification)
$('name').value = state.name

if (state.token) connect()
else show('pair')
