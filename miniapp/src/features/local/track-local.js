import {CanvasSink} from 'mediabunny'
import {call, deviceOf, ready} from './models.js'
import {identity, stage} from './stage-cache.js'
import {open} from './render.js'

const SIDE = 512
const FPS = 30
const RATES = [3, 2, 1]
const STEPS = 45
const CPU_STEPS = 12
const CPU_RATE = 2
const CHUNK = 30
const PROGRESS_EVERY = 10
const GROUP = 'track'
const NAMES = ['sam2.1-video-encoder', 'sam2.1-video-decoder', 'sam2.1-video-mem-enc', 'sam2.1-video-mem-attn', 'sam2.1-video-pointer']

let active = 0
let turn = Promise.resolve()
let preview = null

// [DOC: local-follow]
export const stopFollow = () => {++active}

// [DOC: track-serial]
const exclusive = fn => {
  const run = turn.then(fn)
  turn = run.catch(() => {})
  return run
}

const grid = (time, start, end, steps) => {
  const rate = RATES.find(r => (end - start) * r <= steps) ?? RATES[RATES.length - 1]
  const anchor = Math.floor(time * FPS + 1e-3) / FPS
  const before = Math.floor((anchor - start) * rate + 1e-6)
  const after = Math.floor((end - anchor) * rate + 1e-6)
  return {rate, t0: anchor - before / rate, index: before, n: before + after + 1}
}

// [DOC: track-frames]
async function* frames(file, times, index) {
  const sink = new CanvasSink(await open(file).getPrimaryVideoTrack(), {width: SIDE, height: SIDE, fit: 'fill', poolSize: 1})
  const read = frame => frame ? frame.canvas.getContext('2d').getImageData(0, 0, SIDE, SIDE).data : new Uint8ClampedArray(SIDE * SIDE * 4)
  let k = index
  for await (const frame of sink.canvasesAtTimestamps(times.slice(index))) yield [k++, read(frame)]
  for (let hi = index; hi > 0; hi -= CHUNK) {
    const lo = Math.max(0, hi - CHUNK), chunk = []
    for await (const frame of sink.canvasesAtTimestamps(times.slice(lo, hi))) chunk.push(read(frame))
    for (let i = chunk.length - 1; i >= 0; i--) yield [lo + i, chunk[i]]
  }
}

const send = (type, rgba, extra) => call({group: GROUP, type, rgba: rgba.buffer, ...extra}, [rgba.buffer])

const pass = async (file, times, index, prompt, record, live) => {
  let first = null
  for await (const [k, rgba] of frames(file, times, index)) {
    if (!live()) return false
    if (k === index) {
      if (index > 0) first = rgba.slice()
      record(k, await send('seed', rgba, {prompt, total: times.length - index}))
      continue
    }
    if (k === index - 1) await send('seed', first, {prompt, total: index + 1})
    record(k, await send('step', rgba))
  }
  await call({group: GROUP, type: 'reset'})
  return true
}

const changes = hists => hists.map((b, k) => k ? b.reduce((sum, v, i) => sum + Math.abs(v - hists[k - 1][i]), 0) / 2 : 0)

const median = arr => {
  if (!arr.length) return 0
  const s = Array.from(arr).sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// [DOC: local-track]
const sceneCuts = (d, window = 15, floor = 0.3, ratio = 3.0, minShot = 6) => {
  const cuts = []
  for (let k = 1; k < d.length; k++) {
    const local = d.length > 2 ? median([...d.slice(Math.max(1, k - window), k), ...d.slice(k + 1, k + window + 1)]) : 0
    if (d[k] > floor && d[k] > ratio * local + 0.05 && k - (cuts.at(-1) ?? 0) >= minShot) cuts.push(k)
  }
  return cuts
}

// [DOC: track-reuse]
const promptKey = (file, prompt) => JSON.stringify([...identity(file), prompt.time, prompt.points, prompt.box])
const anchorOf = time => Math.floor(time * FPS + 1e-3) / FPS

const reused = (file, {start, end, prompt}) => preview?.key !== promptKey(file, prompt) ? []
  : preview.samples.filter(({t}) => t >= start - 1e-3 && t <= end + 1e-3)

const plan = (start, end, rate, known, time) => {
  const n = rate === FPS ? Math.max(1, Math.round((end - start) * FPS)) : Math.max(2, Math.floor((end - start) * rate) + 1)
  const ts = known.map(({t}) => t), lo = Math.min(...ts), hi = Math.max(...ts), half = 0.5 / rate + 1e-3
  const covered = t => ts.some(k => Math.abs(k - t) <= half) || (t < lo && lo - t <= 1 / rate) || (t > hi && t - hi <= 1 / rate)
  const times = Array.from({length: n}, (_, i) => start + i / rate).filter(t => !covered(t))
  const anchor = anchorOf(time), near = times.findIndex(t => Math.abs(t - anchor) <= half)
  if (near >= 0) times[near] = anchor
  else times.splice(times.filter(t => t < anchor).length, 0, anchor)
  return {times, index: times.indexOf(anchor)}
}

// [DOC: track-cpu-rate]
const merge = (samples, meta, start, end, cpu) => {
  const list = samples.filter(s => s.found).sort((a, b) => a.t - b.t).filter((s, i, all) => !i || s.t - all[i - 1].t > 1e-6)
  const total = Math.max(1, Math.round((end - start) * FPS))
  const sx = meta.width / SIDE, sy = meta.height / SIDE
  const scale = {cx: sx, cy: sy, r: Math.max(sx, sy), area: 1}
  const found = {present: new Uint8Array(total), cx: new Float64Array(total), cy: new Float64Array(total), r: new Float64Array(total), area: new Float64Array(total)}
  for (let j = 0, i = 0; j < total; j++) {
    const t = start + j / FPS
    while (i < list.length - 2 && list[i + 1].t <= t) i++
    const a = list[i].found, b = list[Math.min(i + 1, list.length - 1)].found, span = list[Math.min(i + 1, list.length - 1)].t - list[i].t
    const w = span > 0 ? Math.min(1, Math.max(0, (t - list[i].t) / span)) : 0
    const both = a.present && b.present, near = w < 0.5 ? a : b
    found.present[j] = both || near.present ? 1 : 0
    for (const key of ['cx', 'cy', 'r', 'area']) found[key][j] = (both ? a[key] * (1 - w) + b[key] * w : near[key]) * scale[key]
  }
  const hists = list.map(s => s.found.hist)
  const cuts = (cpu ? sceneCuts(changes(hists), 3, 0.3, 3.0, 1) : sceneCuts(changes(hists))).map(k => Math.round((list[k].t - start) * FPS))
  return {found, cuts}
}

// [DOC: local-follow]
export const followLocal = async (source, {start, end, prompt}, options = {}) => {
  const run = ++active
  const backend = await ready(GROUP, NAMES, options)
  return exclusive(async () => {
    if (run !== active) return null
    const {rate, t0, index, n} = grid(prompt.time, start, end, backend.gpu ? STEPS : CPU_STEPS)
    const boxes = Array(n).fill(null), found = Array(n).fill(null)
    let done = 0
    const record = (k, item) => {boxes[k] = item.box; found[k] = item; options.onTrack?.(++done / n)}
    const times = Array.from({length: n}, (_, i) => t0 + i / rate)
    if (!await pass(source.file, times, index, prompt, record, () => run === active)) return null
    preview = {key: promptKey(source.file, prompt), samples: times.map((t, k) => ({t, found: found[k]}))}
    return {fps: rate, start: Math.round(t0 * 1000) / 1000, boxes}
  })
}

const runTrack = async (file, meta, {start, end, prompt}, onProgress) => {
  const known = (await deviceOf()).gpu ? [] : reused(file, {start, end, prompt})
  const todo = known.length ? plan(start, end, CPU_RATE, known, prompt.time) : null
  if (todo?.times.length === 1 && known.some(({t}) => Math.abs(t - todo.times[0]) < 1e-6)) {
    onProgress(1)
    return merge(known, meta, start, end, true)
  }
  const backend = await ready(GROUP, NAMES)
  return exclusive(async () => {
    const cpu = !backend.gpu
    const {times, index} = todo && cpu ? todo : plan(start, end, cpu ? CPU_RATE : FPS, [], prompt.time)
    const found = Array(times.length)
    let done = 0
    const record = (k, item) => {
      found[k] = item
      if (++done % (cpu ? 1 : PROGRESS_EVERY) === 0 || done === times.length) onProgress(done / times.length)
    }
    await pass(file, times, index, prompt, record, () => true)
    return merge([...(cpu ? known : []), ...times.map((t, k) => ({t, found: found[k]}))], meta, start, end, cpu)
  })
}

// [DOC: stage-cache]
export const trackLocal = async (file, meta, request, onProgress) => {
  ++active
  const {gpu} = await deviceOf()
  const {start, end, prompt} = request
  return stage(['track', ...identity(file), start, end, prompt, gpu], () => runTrack(file, meta, request, onProgress), () => onProgress(1))
}
