import './mock.css'

const BASE = import.meta.env.BASE_URL
const MAX_DURATION = 20
const STATUS = {done: 'done', failed: 'failed', rendering: 'rendering'}
const SAMPLE = {start: 2, end: 14.5, prompt: {time: 5.033, points: [[0.5, 0.5, 1], [0.2, 0.3, 0]], box: null}, options: {loudnorm: true}}
const BROKEN = 'The file is damaged or incomplete and cannot be opened'
const noop = () => {}
const delay = time => new Promise(resolve => setTimeout(resolve, time))
const url = name => new URL(`${BASE}mock/${name}`, location.href).href

let polls = 0

export const getJob = async id => {
  await delay(300)
  if (id === 'missing') throw new Error('Job not found')
  if (id === 'broken') return {id, status: 'failed', error: BROKEN, meta: null, filmstrip: null, request: null, proxy_url: null, filmstrip_url: null}
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

const outline = (aspect, draw) => {
  const canvas = Object.assign(document.createElement('canvas'), {width: 270, height: Math.round(270 / aspect)})
  const g = canvas.getContext('2d')
  g.filter = 'blur(1px)'
  g.fillStyle = '#fff'
  draw(g, canvas.width, canvas.height)
  return {mask: canvas.toDataURL('image/png'), area: 0}
}

// [DOC: mock-lift]
export const segment = async (id, {points, box}) => {
  await delay(600)
  if (id === 'nolift') throw new Error('The outline is not available, the point still works')
  const {meta} = await (await fetch(url('job.json'))).json()
  const aspect = meta.width / meta.height
  if (box) return {candidates: [outline(aspect, (g, w, h) => g.fillRect(box[0] * w, box[1] * h, (box[2] - box[0]) * w, (box[3] - box[1]) * h))], best: 0}
  const [x, y] = points.find(p => p[2] === 1)
  const disc = r => outline(aspect, (g, w, h) => {g.beginPath(); g.arc(x * w, y * h, r * Math.min(w, h), 0, 2 * Math.PI); g.fill()})
  return points.length > 1 ? {candidates: [disc(0.25)], best: 0} : {candidates: [0.08, 0.16, 0.3].map(disc), best: 1}
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
    initData: 'mock', version: '9.0', platform: 'mock', themeParams: {}, isExpanded: true, isVersionAtLeast: () => true,
    ready: noop, expand: noop, setHeaderColor: noop, setBackgroundColor: noop,
    disableVerticalSwipes: noop, requestFullscreen: noop, close: closeApp,
    HapticFeedback: {selectionChanged: log('selection'), impactOccurred: log('impact'), notificationOccurred: log('notify')}
  }
}
