import {loadModels} from './weights.js'

const TOUCH = '(pointer: coarse)'
// [DOC: model-prepare]
const READ = 0.25

const GUARD = 'rounds.track-guard'
const NO_GPU = 'rounds.no-gpu'

let device = null

// [DOC: local-device]
const tabStore = () => {try {return sessionStorage} catch {return null}}

// [DOC: track-guard]
let armed = 0
let backend = 'wasm'
const mark = () => tabStore()?.setItem(GUARD, backend)
const unmark = () => tabStore()?.removeItem(GUARD)
const guard = {
  arm: () => {if (!armed++ && !document.hidden) mark()},
  clear: () => {if (!--armed) unmark()}
}

export const crashed = tabStore()?.getItem(GUARD) || null
unmark()
if (typeof document === 'object') {
  document.addEventListener('visibilitychange', () => document.hidden ? unmark() : armed && mark())
  addEventListener('pagehide', unmark)
}

export const preferCpu = () => {tabStore()?.setItem(NO_GPU, '1'); device = null}

export const deviceOf = () => device ??= (async () => {
  const adapter = tabStore()?.getItem(NO_GPU) ? null : await navigator.gpu?.requestAdapter().catch(() => null)
  return {gpu: Boolean(adapter && !adapter.info?.isFallbackAdapter), wasm: typeof WebAssembly === 'object'}
})()

// [DOC: model-worker]
let worker = null
let seq = 0
const calls = new Map()
const groups = new Map()

const fail = error => {
  worker?.terminate()
  worker = null
  groups.clear()
  calls.forEach(({reject}) => reject(error))
  calls.clear()
}

const spawn = () => {
  worker = new Worker(new URL('./model-worker.js', import.meta.url), {type: 'module'})
  worker.onmessage = ({data: {id, result, error, share}}) => {
    const call = calls.get(id)
    if (share !== undefined) return call?.onShare?.(share)
    calls.delete(id)
    if (error) call?.reject(new Error(error))
    else call?.resolve(result)
  }
  worker.onerror = event => fail(new Error(event.message || 'Model worker failed'))
}

export const call = (payload, transfer = [], onShare) => new Promise((resolve, reject) => {
  if (!worker) return reject(new Error('Model worker is not running'))
  const id = ++seq
  guard.arm()
  calls.set(id, {resolve: value => {guard.clear(); resolve(value)}, reject: error => {guard.clear(); reject(error)}, onShare})
  worker.postMessage({...payload, id}, transfer)
})

// [DOC: one-model]
export const ready = (group, names, options = {}) => {
  if (groups.has(group)) {options.onLoaded?.(); return groups.get(group)}
  const prepare = (from, to) => share => options.onPrepare?.(from + share * (to - from))
  const task = (async () => {
    const [{gpu}, loaded] = await Promise.all([deviceOf(), loadModels(names, {...options, onRead: prepare(0, READ)})])
    if (!worker) spawn()
    const touch = matchMedia(TOUCH).matches
    if (touch) for (const other of groups.keys()) if (other !== group) {groups.delete(other); call({type: 'drop', group: other}).catch(() => {})}
    const bufs = names.map(name => loaded[name])
    backend = gpu ? 'gpu' : 'wasm'
    const result = await call({type: 'load', group, bufs, gpu, keep: !touch}, bufs, prepare(READ, 1))
    options.onLoaded?.()
    return result
  })()
  groups.set(group, task)
  task.catch(() => {if (groups.get(group) === task) groups.delete(group)})
  return task
}
