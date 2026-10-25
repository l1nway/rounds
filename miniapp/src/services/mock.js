import './mock.css'

const BASE = import.meta.env.BASE_URL
const MAX_DURATION = 20
const STATUS = {done: 'done', failed: 'failed', rendering: 'rendering'}
const SAMPLE = {start: 2, end: 14.5, prompt: {time: 5.033, points: [[0.5, 0.5, 1], [0.2, 0.3, 0]], box: null}, options: {loudnorm: true}}
const noop = () => {}
const delay = time => new Promise(resolve => setTimeout(resolve, time))
const url = name => new URL(`${BASE}mock/${name}`, location.href).href

let polls = 0

export const getJob = async id => {
  await delay(300)
  if (id === 'missing') throw new Error('Job not found')
  const response = await fetch(url('job.json'))
  if (!response.ok) throw new Error('No mock media: run npm run mock')
  const {meta, filmstrip} = await response.json()
  const status = id === 'ingest' && polls++ < 2 ? 'ingesting' : STATUS[id] ?? 'ready'
  const ingested = status !== 'ingesting'
  return {
    id, status, meta, filmstrip, max_duration: MAX_DURATION, request: STATUS[id] ? SAMPLE : null,
    proxy_url: ingested ? url('proxy.mp4') : null, filmstrip_url: ingested ? url('filmstrip.jpg') : null
  }
}

export const postRender = async (id, body) => {
  await delay(900)
  if (id === 'reject') throw new Error('Mock rejection: the range is longer than allowed')
  window.mockRequests.push(body)
  return {status: 'rendering'}
}

const button = Object.assign(document.createElement('button'), {type: 'button', className: 'mock-main', hidden: true})
const clicks = new Set()
button.addEventListener('click', () => clicks.forEach(fn => fn()))

const MainButton = {
  setParams({text, is_visible: visible, is_active: active}) {
    if (text !== undefined) button.textContent = text
    if (visible !== undefined) button.hidden = !visible
    if (active !== undefined) button.disabled = !active
    return this
  },
  show() {button.hidden = false; return this},
  hide() {button.hidden = true; return this},
  showProgress() {button.setAttribute('aria-busy', 'true'); button.disabled = true; return this},
  hideProgress() {button.removeAttribute('aria-busy'); return this},
  onClick(fn) {clicks.add(fn); return this},
  offClick(fn) {clicks.delete(fn); return this}
}

const log = name => (...args) => window.mockHaptics.push([name, ...args].join(' '))

const closeApp = () => {
  const note = Object.assign(document.createElement('p'), {className: 'mock-closed', role: 'status'})
  note.textContent = 'Mini App closed (mock). The bot reports progress in the chat.'
  document.body.append(note)
}

// [DOC: mock-mode]
window.mockHaptics = []
window.mockRequests = []
window.Telegram = {
  WebApp: {
    initData: 'mock', version: '9.0', platform: 'mock', themeParams: {}, isVersionAtLeast: () => true,
    ready: noop, expand: noop, setHeaderColor: noop, setBackgroundColor: noop, setBottomBarColor: noop,
    disableVerticalSwipes: noop, requestFullscreen: noop, close: closeApp, MainButton,
    HapticFeedback: {selectionChanged: log('selection'), impactOccurred: log('impact'), notificationOccurred: log('notify')}
  }
}
document.body.append(button)
