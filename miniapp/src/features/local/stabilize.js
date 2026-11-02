import {VideoSample} from 'mediabunny'
import {createFill} from './fill.js'
import {toner} from './look.js'
import {params} from './motion-fit.js'
import {BUDGET, flows, placer, world} from './motion.js'
import {roundEven, sampler} from './spline.js'
import {identity, stage} from './stage-cache.js'
import {createWarp} from './warp.js'

const FPS = 30

// [DOC: local-stabilization]
export const motionOf = (file, input, meta, start, end, onProgress) =>
  stage(['flows', 2, ...identity(file), start, end, BUDGET.side, BUDGET.corners], async () => flows(await input.getPrimaryVideoTrack(), meta, start, end, onProgress), () => onProgress(1))

export const pathOf = async ({flow, found, cuts = [], meta, request, crop}) => {
  const size = [meta.width, meta.height], n = found?.present.length ?? roundEven((request.end - request.start) * FPS)
  if (flow.t.length < 2) return null
  const w = world(flow, params(flow, size, found, cuts), request.stabilize, size, n)
  const empty = {present: new Uint8Array(n), ...Object.fromEntries(['cx', 'cy', 'r'].map(key => [key, new Float64Array(n).fill(NaN)]))}
  const path = crop ? Array.from({length: n}, () => [crop.left + crop.width / 2, crop.top + crop.height / 2, crop.width])
    : await solveOff(found ?? empty, ...size, cuts, FPS, Boolean(request.options.zoom), w)
  const base = sampler(path, cuts)
  return {world: w, base, at: placer(base, w), times: Array.from(flow.t)}
}

export const solveOff = (...args) => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./camera-worker.js', import.meta.url), {type: 'module'})
  worker.onmessage = ({data}) => {
    worker.terminate()
    if (data.error) reject(new Error(data.error))
    else resolve(data.path)
  }
  worker.onerror = event => {worker.terminate(); reject(new Error(event.message || 'The camera path failed'))}
  worker.postMessage(args)
})

export const stabilizer = ({world: w, base, at, times}, look, ev, size, span) => {
  const glCanvas = new OffscreenCanvas(size, size), warp = createWarp(glCanvas, {size})
  if (!warp) throw new Error('This browser cannot stabilize video')
  let fill = null, done = false
  const dispose = () => {
    if (done) return
    done = true
    warp.g.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  try {fill = createFill(warp.g, {size, n: times.length, world: w, base, times})} catch (error) {dispose(); throw error}
  const {ctx, tone, on} = toner(look, ev, size)
  const frame = new OffscreenCanvas(1, 1), draw = frame.getContext('2d'), stamps = [], ready = []
  const onFrame = (e, tex) => {
    warp.present(tex)
    ready.push(new VideoSample(glCanvas, {timestamp: stamps[e][0], duration: stamps[e][1]}))
  }
  const process = sample => {
    const k = stamps.length, w = sample.displayWidth, h = sample.displayHeight
    if (done || k >= times.length) return null
    stamps.push([sample.timestamp, sample.duration])
    if (frame.width !== w || frame.height !== h) Object.assign(frame, {width: w, height: h})
    sample.drawWithFit(draw, {fit: 'fill'})
    let tex = warp.warp(frame, w, h, at(sample.timestamp * FPS))
    if (on) {
      warp.present(tex)
      ctx.drawImage(glCanvas, 0, 0)
      tex = warp.load(tone(sample.timestamp))
    }
    fill.push(tex, onFrame)
    if (k === times.length - 1 || sample.timestamp + sample.duration >= span - 1e-6) {fill.flush(onFrame); dispose()}
    const out = ready.splice(0)
    return out.length ? out : null
  }
  return {process, dispose}
}
