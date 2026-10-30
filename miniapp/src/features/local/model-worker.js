import * as ort from 'onnxruntime-web/webgpu'
import {forget, segment} from './lift-mask.js'
import {reset, seed, step} from './track-infer.js'

const HANDLERS = {segment, seed, step, reset}
const CLEAR = {lift: forget, track: reset}
const groups = {}
let queue = Promise.resolve()

ort.env.wasm.numThreads = 1
ort.env.logLevel = 'error'

const QUIET = {logSeverityLevel: 3}
const LEAN = {...QUIET, enableCpuMemArena: false, enableMemPattern: false}
// [DOC: gpu-buffer-cache]
const SMALL_GPU = {name: 'webgpu', storageBufferCacheMode: 'lazyRelease'}

const create = async (bufs, gpu, small, report = () => {}) => {
  const sessions = []
  const options = gpu ? {executionProviders: [small ? SMALL_GPU : 'webgpu', 'wasm'], ...QUIET} : {executionProviders: ['wasm'], ...LEAN}
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
const load = async ({group, bufs, gpu, keep}, report) => {
  drop(group)
  const sessions = gpu ? await create(bufs, true, !keep, report).catch(() => null) : null
  groups[group] = sessions ? {sessions, bufs: keep ? bufs : null, gpu: true} : {sessions: await create(bufs, false, false, report), gpu: false}
  return {gpu: groups[group].gpu}
}

const run = async ({group, type, ...data}) => {
  const entry = groups[group]
  if (!entry) throw new Error('Model is not loaded')
  try {
    return await HANDLERS[type](entry.sessions, data)
  } catch (error) {
    if (!entry.gpu || !entry.bufs) throw error
    entry.sessions.forEach(session => session.release())
    Object.assign(entry, {sessions: await create(entry.bufs, false), bufs: null, gpu: false})
    return HANDLERS[type](entry.sessions, data)
  }
}

const handle = async ({id, ...data}) => {
  try {
    const result = data.type === 'load' ? await load(data, share => self.postMessage({id, share})) : data.type === 'drop' ? drop(data.group) : await run(data)
    self.postMessage({id, result: result ?? true})
  } catch (error) {
    self.postMessage({id, error: error?.message || 'Model worker error'})
  }
}

self.onmessage = ({data}) => {queue = queue.then(() => handle(data))}
