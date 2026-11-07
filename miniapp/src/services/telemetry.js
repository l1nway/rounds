import {API, credentials} from './api.js'
import {inTelegram} from './telegram.js'

// [DOC: telemetry]
const PATH = '/api/telemetry'
const INSTALL = 'rounds.install'
const BOX = 'rounds.blackbox'
const FLUSH = 4000
const BEAT = 3000
const LINGER = 4000
const BATCH = 50
const QUEUE = 200
const BOXED = 40
const TEXT = 1200
const SAMPLE = 3000
export const BUILD = typeof __BUILD__ === 'string' ? __BUILD__ : 'dev'

const live = {install: '', session: '', queue: [], box: [], flushAt: 0, beat: 0, open: new Map(), lastDone: 0}

const store = () => {try {return localStorage} catch {return null}}
export const recall = key => {try {return JSON.parse(store()?.getItem(key))} catch {return null}}
export const keep = (key, value) => {try {store()?.setItem(key, JSON.stringify(value))} catch { /* full */ }}
const fresh = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('')
const clip = text => String(text ?? '').slice(0, TEXT)

const flush = () => {
  clearTimeout(live.flushAt)
  live.flushAt = 0
  const auth = credentials()
  if (!live.queue.length || !auth) return
  const events = live.queue.splice(0, BATCH)
  const body = JSON.stringify({auth, install: live.install, session: live.session, build: BUILD, events})
  // [DOC: telemetry-transport]
  fetch(API + PATH, {method: 'POST', body, keepalive: true, headers: {'Content-Type': 'text/plain'}}).catch(() => {})
  if (live.queue.length) flush()
}

// [DOC: telemetry-black-box]
export const report = (kind, data = {}) => {
  if (!live.session) return
  const event = {t: Date.now(), kind, data}
  live.queue.push(event)
  if (live.queue.length > QUEUE) live.queue.shift()
  if (kind !== 'previous') {
    live.box.push(event)
    if (live.box.length > BOXED) live.box.shift()
    keep(BOX, {session: live.session, build: BUILD, events: live.box})
  }
  live.flushAt ||= setTimeout(flush, FLUSH)
}

// [DOC: telemetry-beat]
const tick = () => {
  const work = [...live.open.values()]
  if (!work.length && Date.now() - live.lastDone > LINGER) {clearInterval(live.beat); live.beat = 0; return}
  report('beat', {work})
  flush()
}

export const busy = label => {
  const key = Symbol(label)
  live.open.set(key, label)
  live.beat ||= setInterval(tick, BEAT)
  return () => {if (live.open.delete(key)) live.lastDone = Date.now()}
}

const errorOf = error => ({message: clip(error?.message ?? error), stack: clip(error?.stack)})
const leave = kind => () => {report(kind); flush()}

// [DOC: telemetry]
export const startTelemetry = sample => {
  if (live.session || !API) return
  live.install = recall(INSTALL) ?? fresh()
  keep(INSTALL, live.install)
  live.session = fresh()
  const previous = recall(BOX)
  report('open', {app: inTelegram() ? 'miniapp' : 'web'})
  if (previous?.events?.length) report('previous', previous)
  addEventListener('error', ({error, message, filename, lineno}) => report('error', {...errorOf(error ?? message), at: `${filename?.split('/').pop()}:${lineno}`}))
  addEventListener('unhandledrejection', ({reason}) => report('rejection', errorOf(reason)))
  document.addEventListener('visibilitychange', () => document.hidden ? leave('hidden')() : report('visible'))
  addEventListener('pagehide', leave('pagehide'))
  setTimeout(() => sample?.().catch(error => report('device.fail', errorOf(error))), SAMPLE)
}
