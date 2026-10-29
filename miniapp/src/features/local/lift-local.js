import {deviceOf, loadModels} from './models.js'

const SIDE = 1024
const FPS = 30
const EMBEDDINGS = 8
const MODEL_KEYS = ['sam2.1-tiny-encoder', 'sam2.1-tiny-decoder']

let worker = null
let ready = null
let seq = 0
let canvas = null
let ctx = null
const pending = new Map()
const knownKeys = new Set()

const callWorker = (payload, transfer = []) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, {resolve, reject})
  worker.postMessage({...payload, id}, transfer)
})

const resetWorker = error => {
  if (worker) worker.terminate()
  worker = null
  ready = null
  knownKeys.clear()
  for (const item of pending.values()) item.reject(error)
  pending.clear()
}

const ensureWorker = options => {
  if (ready) return ready
  ready = (async () => {
    const [{gpu}, loaded] = await Promise.all([deviceOf(), loadModels(MODEL_KEYS, options)])
    const encBuf = loaded['sam2.1-tiny-encoder'], decBuf = loaded['sam2.1-tiny-decoder']
    worker = new Worker(new URL('./lift-worker.js', import.meta.url), {type: 'module'})
    worker.onmessage = ({data: {id, result, ok, error}}) => {
      const item = pending.get(id)
      if (!item) return
      pending.delete(id)
      if (error) item.reject(new Error(error))
      else item.resolve(result ?? ok)
    }
    worker.onerror = event => resetWorker(new Error(event.message || 'Lift worker failed'))
    await callWorker({type: 'init', encBuf, decBuf, gpu}, [encBuf, decBuf])
  })().catch(error => {
    resetWorker(error)
    throw error
  })
  return ready
}

const getCtx = () => {
  if (!ctx) {
    canvas = Object.assign(document.createElement('canvas'), {width: SIDE, height: SIDE})
    ctx = canvas.getContext('2d', {willReadFrequently: true})
  }
  return ctx
}

const frameRgba = async (job, time) => {
  const context = getCtx()
  const live = typeof document !== 'undefined' ? document.querySelector('.viewer-video') : null
  if (live?.seeking) {
    await new Promise(resolve => {
      const done = () => {live.removeEventListener('seeked', done); clearTimeout(timer); resolve()}
      const timer = setTimeout(done, 250)
      live.addEventListener('seeked', done)
    })
  }
  if (live?.readyState >= 2) {
    context.drawImage(live, 0, 0, SIDE, SIDE)
    return context.getImageData(0, 0, SIDE, SIDE).data.buffer
  }
  if (job?.file) {
    const [{CanvasSink}, {open}] = await Promise.all([import('mediabunny'), import('./render.js')])
    const track = await open(job.file).getPrimaryVideoTrack()
    const sink = new CanvasSink(track, {width: SIDE, height: SIDE, fit: 'fill'})
    for await (const frame of sink.canvasesAtTimestamps([time])) {
      if (frame) {
        context.drawImage(frame.canvas, 0, 0, SIDE, SIDE)
        return context.getImageData(0, 0, SIDE, SIDE).data.buffer
      }
    }
  }
  throw new Error('Video frame is not ready')
}

// [DOC: local-lift]
export const segmentLocal = async (job, prompt, options) => {
  await ensureWorker(options)
  const index = Math.floor(prompt.time * FPS + 1e-3)
  const key = `${job?.name ?? ''}:${job?.size ?? 0}:${index}`
  const rgba = knownKeys.has(key) ? null : await frameRgba(job, prompt.time)
  const result = await callWorker({
    type: 'segment', key, rgba,
    points: prompt.points, box: prompt.box,
    width: job?.meta?.width || 360, height: job?.meta?.height || 360
  }, rgba ? [rgba] : [])
  knownKeys.delete(key)
  knownKeys.add(key)
  if (knownKeys.size > EMBEDDINGS) knownKeys.delete(knownKeys.values().next().value)
  return result
}
