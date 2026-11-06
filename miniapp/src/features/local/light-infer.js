import * as ort from 'onnxruntime-web/webgpu'
import {histogram} from './track-measure.js'

const SIDE = 512, TEMPLATE = 128, SEARCH = 256, GRID = 16, MIN_SCORE = 0.2, MARGIN = 10, TAP = 0.15
// [DOC: light-relock]
const RELOCK = 0.55, RELOCK_MIN = 0.3, HITS = 3, REF_STEPS = 5, SIZE_RATE = 0.5, SIZE_STEP = 1.1
// [DOC: light-track]
const PLANES = [[2, 0.485, 0.229], [1, 0.456, 0.224], [0, 0.406, 0.225]]
const HANN = Float32Array.from({length: GRID}, (_, i) => 0.5 * (1 - Math.cos(2 * Math.PI / (GRID + 1) * (i + 1))))
const buffers = {[TEMPLATE]: new Float32Array(3 * TEMPLATE * TEMPLATE), [SEARCH]: new Float32Array(3 * SEARCH * SEARCH)}
let state = null

const cropOf = ({w, h}, factor) => Math.ceil(Math.sqrt(w * h) * factor)

const axis = (size, crop) => {
  const lo = new Int32Array(size), hi = new Int32Array(size), frac = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    let f = (i + 0.5) * crop / size - 0.5, s = Math.floor(f)
    f -= s
    if (s < 0) {s = 0; f = 0}
    if (s >= crop - 1) {s = crop - 1; f = 0}
    lo[i] = s; hi[i] = Math.min(s + 1, crop - 1); frac[i] = f
  }
  return {lo, hi, frac}
}

const blob = (bytes, width, height, rect, factor, size) => {
  const crop = cropOf(rect, factor), x1 = rect.x + Math.trunc((rect.w - crop) / 2), y1 = rect.y + Math.trunc((rect.h - crop) / 2)
  const out = buffers[size], plane = size * size, {lo, hi, frac} = axis(size, crop)
  const at = (u, v, ch) => {
    const x = x1 + u, y = y1 + v
    return x >= 0 && y >= 0 && x < width && y < height ? bytes[(y * width + x) * 4 + ch] : 0
  }
  for (let Y = 0; Y < size; Y++) for (let X = 0; X < size; X++) {
    const v0 = lo[Y], v1 = hi[Y], fy = frac[Y], u0 = lo[X], u1 = hi[X], fx = frac[X]
    PLANES.forEach(([ch, mean, std], c) => {
      const top = at(u0, v0, ch) * (1 - fx) + at(u1, v0, ch) * fx, bottom = at(u0, v1, ch) * (1 - fx) + at(u1, v1, ch) * fx
      out[c * plane + Y * size + X] = (Math.round(top * (1 - fy) + bottom * fy) / 255 - mean) / std
    })
  }
  return new ort.Tensor('float32', out, [1, 3, size, size])
}

const clip = ({x, y, w, h}, width, height) => {
  const mx = Math.min(MARGIN, width), my = Math.min(MARGIN, height)
  const x1 = Math.min(Math.max(0, x), width - mx), y1 = Math.min(Math.max(0, y), height - my)
  const x2 = Math.min(Math.max(mx, x + w), width), y2 = Math.min(Math.max(my, y + h), height)
  return {x: x1, y: y1, w: Math.max(mx, x2 - x1), h: Math.max(my, y2 - y1)}
}

const maskBox = async mask => {
  if (!mask || typeof createImageBitmap !== 'function') return null
  try {
    const image = await createImageBitmap(await (await fetch(mask)).blob()), {width: w, height: h} = image
    const g = new OffscreenCanvas(w, h).getContext('2d')
    g.drawImage(image, 0, 0)
    image.close()
    const alpha = g.getImageData(0, 0, w, h).data
    let x0 = w, y0 = h, x1 = -1, y1 = -1
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[(y * w + x) * 4 + 3] >= 128) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
    return x1 < 0 ? null : [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h]
  } catch {return null}
}

const tapBox = (points, width, height) => {
  const picked = points.filter(point => point[2] === 1), half = TAP / 2 * Math.min(width, height)
  const xs = picked.map(point => point[0]), ys = picked.map(point => point[1])
  return [Math.min(...xs) - half / width, Math.min(...ys) - half / height, Math.max(...xs) + half / width, Math.max(...ys) + half / height]
}

const boxOf = async ({box, mask, points = []}, width, height) => {
  const [x0, y0, x1, y1] = await maskBox(mask) ?? box ?? tapBox(points, width, height)
  const x = Math.round(x0 * width), y = Math.round(y0 * height)
  return clip({x, y, w: Math.round(x1 * width) - x, h: Math.round(y1 * height) - y}, width, height)
}

const found = (rect, width, height, rgba, present) => {
  const hist = histogram(new Uint8Array(rgba), width, height)
  if (!present) return {present: false, cx: NaN, cy: NaN, r: NaN, area: 0, box: null, hist}
  const {x, y, w, h} = rect, long = Math.max(width, height)
  const box = [x / width, y / height, (x + w) / width, (y + h) / height]
  return {present: true, cx: (x + w / 2) / width * SIDE, cy: (y + h / 2) / height * SIDE, r: Math.hypot(w, h) / 2 / long * SIDE, area: w * h / (width * height) * SIDE * SIDE, box, hist}
}

export const seed = async (sessions, {rgba, width, height, prompt}) => {
  const rect = await boxOf(prompt, width, height)
  state = {rect, template: blob(new Uint8Array(rgba), width, height, rect, 2, TEMPLATE), lost: false, scores: [], ref: 1, hit: null}
  return found(rect, width, height, rgba, true)
}

const median = values => [...values].sort((a, b) => a - b)[values.length >> 1]

// [DOC: light-relock]
const relock = (rect, px, py, score, width, height) => {
  const [hx, hy, hn] = state.hit ?? [NaN, NaN, 0], moved = clip({x: Math.round(px - rect.w / 2), y: Math.round(py - rect.h / 2), w: rect.w, h: rect.h}, width, height)
  const hits = score < Math.max(RELOCK_MIN, RELOCK * state.ref) ? 0 : Math.hypot(px - hx, py - hy) <= Math.hypot(rect.w, rect.h) ? hn + 1 : 1
  state.hit = hits ? [px, py, hits] : null
  state.rect = moved
  state.lost = hits < HITS
  return !state.lost
}

const grow = (prev, next) => prev * Math.min(SIZE_STEP, Math.max(1 / SIZE_STEP, 1 + (next / prev - 1) * SIZE_RATE))

export const step = async ([net], {rgba, width, height}) => {
  if (!state) throw new Error('Tracking was not seeded')
  const {rect} = state, crop = cropOf(rect, 4)
  const out = await net.run({template: state.template, search: blob(new Uint8Array(rgba), width, height, rect, 4, SEARCH)})
  const conf = out.output1.data, size = out.output2.data, offset = out.output3.data, plane = GRID * GRID
  let best = 0, score = -Infinity
  for (let i = 0; i < plane; i++) {
    const value = conf[i] * HANN[Math.trunc(i / GRID)] * HANN[i % GRID]
    if (value > score) {score = value; best = i}
  }
  if (score < MIN_SCORE) {Object.assign(state, {lost: true, hit: null}); return {...found(rect, width, height, rgba, false), score}}
  const x0 = rect.x + Math.trunc((rect.w - crop) / 2), y0 = rect.y + Math.trunc((rect.h - crop) / 2)
  const px = (best % GRID + offset[best]) / GRID * crop + x0, py = (Math.trunc(best / GRID) + offset[plane + best]) / GRID * crop + y0
  if (state.lost) {
    const back = relock(rect, px, py, score, width, height)
    return {...found(state.rect, width, height, rgba, back), score}
  }
  const w = grow(rect.w, size[best] * crop), h = grow(rect.h, size[plane + best] * crop)
  state.rect = clip({x: Math.floor(px - w / 2), y: Math.floor(py - h / 2), w: Math.floor(w), h: Math.floor(h)}, width, height)
  if (state.scores.length < REF_STEPS) {state.scores.push(score); state.ref = median(state.scores)}
  return {...found(state.rect, width, height, rgba, true), score}
}

export const reset = () => {state = null}
