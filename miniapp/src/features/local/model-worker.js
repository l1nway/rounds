import * as ort from 'onnxruntime-web/webgpu'
import * as light from './light-infer.js'
import {forget, segment} from './lift-mask.js'
import {reset, seed, step} from './track-infer.js'

const HANDLERS = {lift: {segment}, track: {seed, step, reset}, light}
const CLEAR = {lift: forget, track: reset, light: light.reset}
const groups = {}
let queue = Promise.resolve()

// [DOC: gpu-teardown]
if (self.GPUDevice) Object.defineProperty(GPUDevice.prototype, 'onuncapturederror', {configurable: true, get: () => null, set: () => {}})

// [DOC: wasm-threads]
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1
ort.env.logLevel = 'error'

const QUIET = {logSeverityLevel: 3}
const LEAN = {...QUIET, enableCpuMemArena: false, enableMemPattern: false}
const create = async (bufs, gpu, cache, report = () => {}) => {
  const sessions = []
  const options = gpu ? {executionProviders: [cache ? {name: 'webgpu', storageBufferCacheMode: cache} : 'webgpu', 'wasm'], ...QUIET} : {executionProviders: ['wasm'], ...LEAN}
  try {
    // [DOC: model-prepare]
    for (const buf of bufs) {sessions.push(await ort.InferenceSession.create(buf, options)); report(sessions.length / bufs.length)}
    return sessions
  } catch (error) {
    sessions.forEach(session => session.release())
    throw error
  }
}

const drop = name => {
  CLEAR[name]?.()
  groups[name]?.sessions.forEach(session => session.release())
  delete groups[name]
}

// [DOC: model-worker]
// [DOC: gpu-buffer-cache]
const load = async ({group, bufs, gpu, keep, solo, cache}, report) => {
  (solo ? Object.keys(groups) : [group]).forEach(drop)
  let reason = null
  const sessions = gpu ? await create(bufs, true, cache, report).catch(error => {reason = error?.message || String(error); return null}) : null
  groups[group] = sessions ? {sessions, bufs: keep ? bufs : null, gpu: true} : {sessions: await create(bufs, false, false, report), gpu: false}
  // [DOC: model-drop]
  if (!keep) bufs.forEach(buf => buf.transfer?.(0))
  return {gpu: groups[group].gpu, reason}
}

const run = async ({group, type, ...data}) => {
  const entry = groups[group]
  if (!entry) throw new Error('Model is not loaded')
  try {
    return await HANDLERS[group][type](entry.sessions, data)
  } catch (error) {
    if (!entry.gpu || !entry.bufs) throw error
    entry.sessions.forEach(session => session.release())
    Object.assign(entry, {sessions: await create(entry.bufs, false), bufs: null, gpu: false})
    return HANDLERS[group][type](entry.sessions, data)
  }
}

const handle = async ({id, ...data}) => {
  try {
    // [DOC: gpu-teardown]
    const result = data.type === 'load' ? await load(data, share => self.postMessage({id, share}))
      : data.type === 'drop' ? Object.keys(groups).forEach(drop) : await run(data)
    self.postMessage({id, result: result ?? true})
  } catch (error) {
    self.postMessage({id, error: error?.message || 'Model worker error'})
  }
}

// [DOC: wasm-threads]
if (!self.name?.startsWith('em-pthread')) self.onmessage = ({data}) => {queue = queue.then(() => handle(data))}
