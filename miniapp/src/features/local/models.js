import {jobId} from '../../services/api.js'
import {BUILD, busy, keep, recall, report} from '../../services/telemetry.js'
import {conditions} from './device.js'
import {loadModels} from './weights.js'

const TOUCH = '(pointer: coarse)'
// [DOC: model-prepare]
const READ = 0.25

const GUARD = 'rounds.track-guard'
const NO_GPU = 'rounds.no-gpu'
// [DOC: speed-gate]
const FAST_LIFT = 800
// [DOC: light-memory]
const ROOMY_GB = 8
// [DOC: model-telemetry]
const QUIET = 2000

let device = null
let pace = Infinity

// [DOC: local-device]
const tabStore = () => {try {return sessionStorage} catch {return null}}
// [DOC: crash-route]
const OFF = 'rounds.off'
const video = typeof location === 'object' ? jobId() : null
const guardStore = () => {try {return video ? localStorage : sessionStorage} catch {return null}}

// [DOC: track-guard]
let armed = 0
let backend = 'wasm'
let load = 'normal'
let calm = false
const mark = () => guardStore()?.setItem(GUARD, JSON.stringify({backend, load, video}))
const unmark = () => guardStore()?.removeItem(GUARD)
const guard = {
  arm: () => {if (!armed++ && !document.hidden) mark()},
  clear: () => {if (!--armed) unmark()}
}

const parse = text => {try {return JSON.parse(text)} catch {return text ? {backend: text} : null}}
const last = parse(guardStore()?.getItem(GUARD))
export const crashed = last?.backend ?? null
unmark()

// [DOC: crash-route]
const offOf = () => {const off = recall(OFF); return video && off?.video === video && off.build === BUILD ? off : {}}
const ours = Boolean(video && last?.video === video)
if (ours && last.load === 'normal') keep(OFF, {...offOf(), video, build: BUILD, [last.backend === 'gpu' ? 'gpu' : 'local']: true})
if (last) report('crash', {backend: last.backend, load: last.load ?? null, app: video ? 'miniapp' : 'web'})
export const localOff = () => Boolean(offOf().local)
const NOTES = {
  gpu: 'The last try stopped the editor, so this video now runs on the processor: slower, but it needs less memory.',
  local: 'The last try stopped the editor, so this video now leaves the heavy work to the server.',
  load: 'The last try stopped the editor, maybe because the phone was hot, cold, low on charge or in Low Power Mode. Let it rest or charge, then try again.'
}
export const crashNote = () => calm || !ours ? null : NOTES[last.load !== 'normal' ? 'load' : last.backend === 'gpu' ? 'gpu' : 'local']
if (typeof document === 'object') {
  document.addEventListener('visibilitychange', () => document.hidden ? unmark() : armed && mark())
  addEventListener('pagehide', unmark)
}

export const preferCpu = () => {tabStore()?.setItem(NO_GPU, '1'); device = null}

// [DOC: speed-gate]
export const notePace = ms => {pace = Math.min(pace, ms)}
export const fast = () => !matchMedia(TOUCH).matches || pace <= FAST_LIFT
// [DOC: light-memory]
export const roomy = () => (navigator.deviceMemory ?? 0) >= ROOMY_GB

// [DOC: device-load]
export const deviceOf = () => device ??= (async () => {
  const off = tabStore()?.getItem(NO_GPU) || offOf().gpu
  const [now, adapter] = await Promise.all([conditions().catch(() => null), off ? null : navigator.gpu?.requestAdapter().catch(() => null)])
  load = now?.load ?? 'normal'
  return {gpu: Boolean(adapter && !adapter.info?.isFallbackAdapter) && load === 'normal', wasm: typeof WebAssembly === 'object', load}
})()

// [DOC: model-worker]
let worker = null
let touched = false
let seq = 0
const calls = new Map()
const groups = new Map()
const stats = {calls: {}, timer: 0}

// [DOC: gpu-teardown]
const fail = error => {
  if (touched) worker?.postMessage({type: 'drop'})
  else {worker?.terminate(); worker = null}
  groups.clear()
  calls.forEach(({reject}) => reject(error))
  calls.clear()
}
const restart = () => fail(new Error('Model is not loaded'))

const spawn = () => {
  worker = new Worker(new URL('./model-worker.js', import.meta.url), {type: 'module'})
  worker.onmessage = ({data: {id, result, error, share}}) => {
    const call = calls.get(id)
    if (share !== undefined) return call?.onShare?.(share)
    calls.delete(id)
    if (error) call?.reject(new Error(error))
    else call?.resolve(result)
  }
  worker.onerror = event => {
    report('model.fail', {message: String(event.message).slice(0, 500), touched})
    fail(new Error(event.message || 'Model worker failed'))
  }
}

// [DOC: model-telemetry]
const summary = () => {report('model.calls', stats.calls); stats.calls = {}}
const kindOf = ({group, type, rgba}) => `${group}.${type === 'segment' && !rgba ? 'lookup' : type}`
const timed = (payload, t0, ok, value) => {
  const key = `${kindOf(payload)}.${backend}${ok ? '' : '.failed'}`, took = performance.now() - t0
  const s = stats.calls[key] ??= {n: 0, ms: 0, max: 0, first: Math.round(took)}
  s.n++; s.ms = Math.round(s.ms + took); s.max = Math.max(s.max, Math.round(took))
  if (!ok) s.error = String(value?.message).slice(0, 300)
  clearTimeout(stats.timer)
  stats.timer = setTimeout(summary, QUIET)
}

export const call = (payload, transfer = [], onShare) => new Promise((resolve, reject) => {
  if (!worker) return reject(new Error('Model worker is not running'))
  const id = ++seq, t0 = performance.now(), done = busy(kindOf(payload))
  const settle = (ok, then) => value => {guard.clear(); done(); timed(payload, t0, ok, value); calm ||= ok && payload.type !== 'load'; then(value)}
  guard.arm()
  calls.set(id, {resolve: settle(true, resolve), reject: settle(false, reject), onShare})
  worker.postMessage({...payload, id}, transfer)
})

// [DOC: one-model]
export const release = () => {if (matchMedia(TOUCH).matches) restart()}

export const ready = (group, names, options = {}) => {
  if (groups.has(group)) {options.onLoaded?.(); return groups.get(group)}
  const prepare = (from, to) => share => options.onPrepare?.(from + share * (to - from))
  const task = (async () => {
    const [found, loaded] = await Promise.all([deviceOf(), loadModels(names, {...options, onRead: prepare(0, READ)})])
    const touch = matchMedia(TOUCH).matches, gpu = found.gpu && !options.cpu, solo = touch && !options.shared
    const others = [...groups.keys()].filter(other => other !== group)
    // [DOC: gpu-teardown]
    if (solo && others.length) {if (touched) others.forEach(other => groups.delete(other)); else restart(); groups.set(group, task)}
    if (!worker) spawn()
    const bufs = names.map(name => loaded[name])
    backend = gpu ? 'gpu' : 'wasm'
    touched ||= gpu
    const result = await call({type: 'load', group, bufs, gpu, keep: !touch, solo, cache: touch ? options.cache : undefined}, bufs, prepare(READ, 1))
    backend = result.gpu ? 'gpu' : 'wasm'
    report('model.load', {group, names, asked: gpu, gpu: result.gpu, reason: result.reason ?? null, cache: touch ? options.cache ?? null : null})
    if (result.reason && import.meta.env.DEV) console.warn('WebGPU failed, running on the processor:', result.reason)
    options.onLoaded?.()
    return result
  })()
  groups.set(group, task)
  task.catch(() => {if (groups.get(group) === task) groups.delete(group)})
  return task
}
