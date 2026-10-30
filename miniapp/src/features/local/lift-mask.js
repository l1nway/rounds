import * as ort from 'onnxruntime-web/webgpu'

const SIDE = 1024
const GRID = 256
const EMBEDDINGS = 4
const MAX_MASK = 480

const KEEP_BLOB = 0.2
const FEATHER = 1.2
const RADIUS = 4
const EDGE = 4
const SAME = 0.9
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

const KERNEL = (() => {
  const weights = Float32Array.from({length: RADIUS * 2 + 1}, (_, i) => Math.exp(-((i - RADIUS) ** 2) / (2 * FEATHER * FEATHER)))
  const sum = weights.reduce((a, b) => a + b, 0)
  return weights.map(w => w / sum)
})()

// [DOC: local-lift-mask]
const toChw = rgba => {
  const bytes = new Uint8Array(rgba), plane = SIDE * SIDE, out = new Float32Array(3 * plane)
  const [s0, s1, s2] = STD.map(s => 1 / (255 * s)), [o0, o1, o2] = MEAN.map((m, i) => m / STD[i])
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = bytes[p] * s0 - o0
    out[plane + i] = bytes[p + 1] * s1 - o1
    out[2 * plane + i] = bytes[p + 2] * s2 - o2
  }
  return out
}

const clean = (logits, w, h, [gw, gh]) => {
  const n = w * h, bin = new Uint8Array(n), eroded = new Uint8Array(n), opened = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, Math.min(GRID - 1, (y + 0.5) * gh / h - 0.5))
    const y0 = sy | 0, y1 = Math.min(GRID - 1, y0 + 1), wy = sy - y0, r0 = y0 * GRID, r1 = y1 * GRID
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, Math.min(GRID - 1, (x + 0.5) * gw / w - 0.5))
      const x0 = sx | 0, x1 = Math.min(GRID - 1, x0 + 1), wx = sx - x0
      const v0 = logits[r0 + x0] * (1 - wx) + logits[r0 + x1] * wx
      const v1 = logits[r1 + x0] * (1 - wx) + logits[r1 + x1] * wx
      bin[y * w + x] = v0 * (1 - wy) + v1 * wy > 0 ? 1 : 0
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1)
      let ok = 1
      for (let ny = y0; ny <= y1 && ok; ny++) for (let nx = x0; nx <= x1; nx++) if (!bin[ny * w + nx]) {ok = 0; break}
      eroded[y * w + x] = ok
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1)
      let ok = 0
      for (let ny = y0; ny <= y1 && !ok; ny++) for (let nx = x0; nx <= x1; nx++) if (eroded[ny * w + nx]) {ok = 1; break}
      opened[y * w + x] = ok
    }
  }
  const labels = new Int32Array(n), queue = new Int32Array(n), areas = [0]
  let maxArea = 0
  for (let i = 0; i < n; i++) {
    if (!opened[i] || labels[i]) continue
    const id = areas.length
    labels[i] = id
    let head = 0, tail = 0
    queue[tail++] = i
    while (head < tail) {
      const cur = queue[head++], cy = (cur / w) | 0, cx = cur - cy * w
      const y0 = Math.max(0, cy - 1), y1 = Math.min(h - 1, cy + 1), x0 = Math.max(0, cx - 1), x1 = Math.min(w - 1, cx + 1)
      for (let ny = y0; ny <= y1; ny++) for (let nx = x0; nx <= x1; nx++) {
        const nb = ny * w + nx
        if (opened[nb] && !labels[nb]) {labels[nb] = id; queue[tail++] = nb}
      }
    }
    areas.push(tail)
    if (tail > maxArea) maxArea = tail
  }
  if (!maxArea) return {mask: new Uint8Array(n), sum: 0}
  const keep = new Uint8Array(n), minArea = KEEP_BLOB * maxArea
  for (let i = 0; i < n; i++) if (labels[i] && areas[labels[i]] >= minArea) keep[i] = 1
  const out = new Uint8Array(n)
  let head = 0, tail = 0
  const seed = i => {if (!keep[i] && !out[i]) {out[i] = 1; queue[tail++] = i}}
  for (let x = 0; x < w; x++) {seed(x); seed((h - 1) * w + x)}
  for (let y = 1; y < h - 1; y++) {seed(y * w); seed(y * w + w - 1)}
  while (head < tail) {
    const cur = queue[head++], cy = (cur / w) | 0, cx = cur - cy * w
    if (cx > 0) seed(cur - 1)
    if (cx + 1 < w) seed(cur + 1)
    if (cy > 0) seed(cur - w)
    if (cy + 1 < h) seed(cur + w)
  }
  const filled = new Uint8Array(n)
  let sum = 0
  for (let y = EDGE; y < h - EDGE; y++) for (let x = EDGE; x < w - EDGE; x++) {
    const i = y * w + x
    if (!out[i]) {filled[i] = 1; sum++}
  }
  return {mask: filled, sum}
}

const distinct = items => {
  const kept = []
  for (const item of items.filter(m => m.sum > 0).sort((a, b) => a.sum - b.sum)) {
    const ok = kept.every(prev => {
      let inter = 0, union = 0
      for (let i = 0; i < item.mask.length; i++) {
        const a = item.mask[i], b = prev.mask[i]
        inter += a & b
        union += a | b
      }
      return inter < SAME * union
    })
    if (ok) kept.push(item)
  }
  return kept
}

const feather = (mask, w, h) => {
  const tmp = new Float32Array(w * h), rgba = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -RADIUS; k <= RADIUS; k++) acc += mask[row + Math.min(w - 1, Math.max(0, x + k))] * KERNEL[k + RADIUS]
      tmp[row + x] = acc
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0
    for (let k = -RADIUS; k <= RADIUS; k++) acc += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x] * KERNEL[k + RADIUS]
    const p = (y * w + x) * 4
    rgba[p] = rgba[p + 1] = rgba[p + 2] = 255
    rgba[p + 3] = Math.round(acc * 255)
  }
  return rgba
}

const png = async (mask, w, h) => {
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d').putImageData(new ImageData(feather(mask, w, h), w, h), 0, 0)
  const bytes = new Uint8Array(await (await canvas.convertToBlob({type: 'image/png'})).arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:image/png;base64,${btoa(bin)}`
}

const cache = new Map()
const zeroMask = new ort.Tensor('float32', new Float32Array(GRID * GRID), [1, 1, GRID, GRID])
const noMask = new ort.Tensor('float32', new Float32Array([0]), [1])

export const forget = () => cache.clear()

const sam2Feeds = (emb, all, coords) => ({
  ...emb,
  input_points: new ort.Tensor('float32', coords, [1, 1, all.length, 2]),
  input_labels: new ort.Tensor('int64', BigInt64Array.from(all, p => BigInt(p[2])), [1, 1, all.length]),
  input_masks: zeroMask,
  has_mask_input: noMask
})

// [DOC: lift-model]
const edgeFeeds = (emb, all, coords) => ({
  ...emb,
  point_coords: new ort.Tensor('float32', coords, [1, all.length, 2]),
  point_labels: new ort.Tensor('float32', Float32Array.from(all, p => p[2]), [1, all.length])
})

// [DOC: local-lift]
export const segment = async ([enc, dec], {key, rgba, points, box, width, height, frame = [SIDE, SIDE]}) => {
  const edge = enc.inputNames[0] === 'image'
  let emb = cache.get(key)
  if (!emb && !rgba) return {miss: true}
  if (!emb) {
    emb = await enc.run({[enc.inputNames[0]]: new ort.Tensor('float32', toChw(rgba), [1, 3, SIDE, SIDE])})
    if (cache.size >= EMBEDDINGS) cache.delete(cache.keys().next().value)
  }
  cache.delete(key)
  cache.set(key, emb)
  const all = [...(box ? [[box[0], box[1], 2], [box[2], box[3], 3]] : []), ...(points ?? [])]
  if (edge && !box) all.push([0, 0, -1])
  const coords = Float32Array.from(all.flatMap(([x, y, l]) => l < 0 ? [0, 0] : [x * frame[0], y * frame[1]]))
  const out = await dec.run((edge ? edgeFeeds : sam2Feeds)(emb, all, coords))
  const logits = out.masks ?? out.pred_masks
  const grid = frame.map(side => side * GRID / SIDE)
  const scale = Math.min(0.5, MAX_MASK / Math.max(width, height))
  const mw = Math.max(16, Math.round(width * scale)), mh = Math.max(16, Math.round(height * scale))
  const slots = (points?.length ?? 0) === 1 && !box ? [1, 2, 3] : [0]
  const kept = distinct(slots.map(s => clean(logits.data.subarray(s * GRID * GRID, (s + 1) * GRID * GRID), mw, mh, grid)))
  const candidates = await Promise.all(kept.map(async m => ({mask: await png(m.mask, mw, mh), area: Math.round(m.sum / (mw * mh) * 1e4) / 1e4})))
  return {candidates, best: candidates.length >> 1}
}
