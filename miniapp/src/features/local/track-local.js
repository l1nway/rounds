import {CanvasSink} from 'mediabunny'
import {open} from './render.js'
import {deviceOf, loadModels} from './models.js'

const SIDE = 512
const FPS = 30
const RATES = [10, 6, 5]
const STEPS = 360
const PREVIEW_RATES = [3, 2, 1]
const PREVIEW_STEPS = 45
const MODEL_KEYS = ['sam2.1-video-encoder', 'sam2.1-video-decoder', 'sam2.1-video-mem-enc', 'sam2.1-video-mem-attn', 'sam2.1-video-pointer']

let worker = null
let ready = null
let seq = 0
let activeRun = 0
const pending = new Map()

const callWorker = (payload, transfer = []) => new Promise((resolve, reject) => {
  const id = ++seq
  pending.set(id, {resolve, reject})
  worker.postMessage({...payload, id}, transfer)
})

const resetWorker = error => {
  if (worker) worker.terminate()
  worker = null
  ready = null
  for (const item of pending.values()) item.reject(error)
  pending.clear()
}

const ensureWorker = options => {
  if (ready) return ready
  ready = (async () => {
    const [{gpu}, loaded] = await Promise.all([deviceOf(), loadModels(MODEL_KEYS, options)])
    const bufs = MODEL_KEYS.map(k => loaded[k])
    worker = new Worker(new URL('./track-worker.js', import.meta.url), {type: 'module'})
    worker.onmessage = ({data: {id, result, ok, error}}) => {
      const item = pending.get(id)
      if (!item) return
      pending.delete(id)
      if (error) item.reject(new Error(error))
      else item.resolve(result ?? ok)
    }
    worker.onerror = event => resetWorker(new Error(event.message || 'Track worker failed'))
    const [encBuf, decBuf, memEncBuf, memAttnBuf, ptrBuf] = bufs
    await callWorker({type: 'init', encBuf, decBuf, memEncBuf, memAttnBuf, ptrBuf, gpu}, bufs)
  })().catch(error => {
    resetWorker(error)
    throw error
  })
  return ready
}

export const grid = (time, start, end, rates = RATES, steps = STEPS) => {
  const dur = end - start
  const rate = rates.find(r => dur * r <= steps) ?? rates[rates.length - 1]
  const anchor = Math.floor(time * FPS + 1e-3) / FPS
  const before = Math.floor((anchor - start) * rate + 1e-6)
  const after = Math.floor((end - anchor) * rate + 1e-6)
  return {rate, t0: anchor - before / rate, index: before, n: before + after + 1}
}

const decodeFrames = async (file, times) => {
  const input = open(file)
  const track = await input.getPrimaryVideoTrack()
  const sink = new CanvasSink(track, {width: SIDE, height: SIDE, fit: 'fill'})
  const frames = []
  for await (const frame of sink.canvasesAtTimestamps(times)) {
    if (!frame) {
      frames.push(frames.length ? frames[frames.length - 1].slice() : new Uint8Array(SIDE * SIDE * 4))
      continue
    }
    const ctx = frame.canvas.getContext('2d')
    frames.push(ctx.getImageData(0, 0, SIDE, SIDE).data)
  }
  return frames
}

export const changes = hists => {
  const n = hists.length, d = new Float64Array(n)
  d[0] = 0
  for (let k = 1; k < n; k++) {
    const a = hists[k - 1], b = hists[k]
    let sum = 0
    for (let i = 0; i < 512; i++) sum += Math.abs(b[i] - a[i])
    d[k] = sum / 2
  }
  return d
}

const median = arr => {
  if (!arr.length) return 0
  const s = Array.from(arr).sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export const sceneCuts = (d, window = 15, floor = 0.3, ratio = 3.0, minShot = 6) => {
  const cuts = []
  for (let k = 1; k < d.length; k++) {
    const left = d.subarray(Math.max(1, k - window), k)
    const right = d.subarray(k + 1, Math.min(d.length, k + window + 1))
    const merged = new Float64Array(left.length + right.length)
    merged.set(left); merged.set(right, left.length)
    const local = d.length > 2 ? median(merged) : 0
    if (d[k] > floor && d[k] > ratio * local + 0.05 && k - (cuts.length ? cuts[cuts.length - 1] : 0) >= minShot) cuts.push(k)
  }
  return cuts
}

const toSource = (found, meta) => {
  const sx = meta.width / SIDE, sy = meta.height / SIDE, sMax = Math.max(sx, sy)
  return {
    ...found,
    cx: found.cx.map(v => v * sx),
    cy: found.cy.map(v => v * sy),
    r: found.r.map(v => v * sMax)
  }
}

// [DOC: local-follow]
export const followLocal = async (source, {start, end, prompt}, options = {}) => {
  const runId = ++activeRun
  await ensureWorker(options)
  const {rate, t0, index, n} = grid(prompt.time, start, end, PREVIEW_RATES, PREVIEW_STEPS)
  const times = Array.from({length: n}, (_, i) => t0 + i / rate)
  const frames = await decodeFrames(source.file, times)
  if (runId !== activeRun) return null
  const boxes = Array.from({length: n}, () => null)
  let done = 0
  const report = () => options.onTrack?.(done / n)
  const fSeed = await callWorker({type: 'seed', rgba: frames[index].slice().buffer, prompt, total: n - index, width: SIDE, height: SIDE})
  if (fSeed?.box) boxes[index] = fSeed.box
  done++
  report()
  for (let k = index + 1; k < n; k++) {
    if (runId !== activeRun) return null
    const res = await callWorker({type: 'step', rgba: frames[k].buffer, width: SIDE, height: SIDE})
    if (res?.box) boxes[k] = res.box
    done++
    report()
  }
  if (index > 0) {
    if (runId !== activeRun) return null
    await callWorker({type: 'seed', rgba: frames[index].buffer, prompt, total: index + 1, width: SIDE, height: SIDE})
    for (let k = index - 1; k >= 0; k--) {
      if (runId !== activeRun) return null
      const res = await callWorker({type: 'step', rgba: frames[k].buffer, width: SIDE, height: SIDE})
      if (res?.box) boxes[k] = res.box
      done++
      report()
    }
  }
  await callWorker({type: 'release'})
  return {fps: rate, start: Math.round(t0 * 1000) / 1000, boxes}
}

// [DOC: local-track]
export const trackLocal = async (file, meta, {start, end, prompt}, options = {}, onProgress = null) => {
  await ensureWorker(options)
  const n = Math.round((end - start) * FPS)
  const index = Math.min(n - 1, Math.max(0, Math.round((prompt.time - start) * FPS)))
  const times = Array.from({length: n}, (_, i) => start + i / FPS)
  const frames = await decodeFrames(file, times)
  const present = new Uint8Array(n), cx = new Float64Array(n), cy = new Float64Array(n), r = new Float64Array(n), area = new Float64Array(n)
  const hists = Array.from({length: n}, () => null)
  let done = 0
  const record = (k, res) => {
    present[k] = res.present ? 1 : 0; cx[k] = res.cx; cy[k] = res.cy; r[k] = res.r; area[k] = res.area; hists[k] = res.hist
    done++; if (onProgress && (done % 10 === 0 || done === n)) onProgress(done / n)
  }
  const fSeed = await callWorker({type: 'seed', rgba: frames[index].slice().buffer, prompt, total: n - index, width: SIDE, height: SIDE})
  record(index, fSeed)
  for (let k = index + 1; k < n; k++) record(k, await callWorker({type: 'step', rgba: frames[k].buffer, width: SIDE, height: SIDE}))
  if (index > 0) {
    await callWorker({type: 'seed', rgba: frames[index].buffer, prompt, total: index + 1, width: SIDE, height: SIDE})
    for (let k = index - 1; k >= 0; k--) record(k, await callWorker({type: 'step', rgba: frames[k].buffer, width: SIDE, height: SIDE}))
  }
  await callWorker({type: 'release'})
  const cuts = sceneCuts(changes(hists))
  return {found: toSource({present, cx, cy, r, area}, meta), cuts}
}
