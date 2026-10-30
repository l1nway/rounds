import {VideoSampleSink} from 'mediabunny'
import {CORNERS} from './motion-flow.js'
import {gaussianFilter1d, interp, roundEven} from './spline.js'

const FPS = 30
const SLOW = 0.5
const CHUNK = 30
// [DOC: baked-disc]
const DISC_IN = 0.94, DISC_OUT = 1.04, DISC_FLAT = 4, DISC_SIDES = 16, DISC_SAFE = 0.98
// [DOC: motion-budget]
export const BUDGET = {side: 480, corners: CORNERS, workers: Math.min(4, Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 2)), queue: 4}

const even = x => Math.max(2, roundEven(x / 2) * 2)

export const ring = (w, h, r0, r1 = Infinity) => Uint8Array.from({length: w * h}, (_, k) => {
  const rho = Math.hypot(k % w + 0.5 - w / 2, Math.floor(k / w) + 0.5 - h / 2) / (Math.min(w, h) / 2)
  return rho >= r0 && rho < r1
})

export const flat = (img, w, h) => {
  if (w !== h) return false
  const out = ring(w, h, DISC_OUT), v = img.filter((_, k) => out[k]), mean = v.reduce((a, b) => a + b, 0) / v.length
  return Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length) < DISC_FLAT
}

const pool = (count, onPairs) => {
  const workers = Array.from({length: count}, () => new Worker(new URL('./motion-worker.js', import.meta.url), {type: 'module'}))
  const busy = workers.map(() => 0), waits = workers.map(() => [])
  let failed = null
  const wake = i => waits[i].splice(0).forEach(go => go())
  workers.forEach((worker, i) => {
    worker.onmessage = ({data}) => {
      if (data.error) failed = new Error(data.error)
      else if (data.pairs) onPairs(data.index, data.pairs)
      busy[i]--
      wake(i)
    }
    worker.onerror = event => {failed = new Error(event.message || 'Motion analysis failed'); busy[i] = 0; wake(i)}
  })
  const send = async (i, message, transfer) => {
    while (busy[i] >= BUDGET.queue && !failed) await new Promise(go => waits[i].push(go))
    if (failed) throw failed
    busy[i]++
    workers[i].postMessage(message, transfer)
  }
  const drain = async () => {
    for (let i = 0; i < count; i++) while (busy[i] && !failed) await new Promise(go => waits[i].push(go))
    if (failed) throw failed
  }
  return {send, drain, close: () => workers.forEach(worker => worker.terminate())}
}

// [DOC: local-motion-flow]
export const flows = async (track, {width: w, height: h}, start, end, onProgress = () => {}) => {
  const k = Math.min(1, BUDGET.side / Math.min(w, h)), sw = even(w * k), sh = even(h * k), sx = w / sw, sy = h / sh
  const canvas = new OffscreenCanvas(sw, sh), ctx = canvas.getContext('2d', {willReadFrequently: true})
  const t = [], pairs = [], count = BUDGET.workers
  const work = pool(count, (i, raw) => {pairs[i] = Float64Array.from(raw, (v, j) => Math.fround(v + 0.5) * (j % 2 ? sy : sx))})
  let first = null, last = null, mask = null
  try {
    for await (const sample of new VideoSampleSink(track).samples(start, end)) {
      const i = t.length
      t.push(sample.timestamp - start)
      sample.drawWithFit(ctx, {fit: 'fill'})
      sample.close()
      const rgba = ctx.getImageData(0, 0, sw, sh).data, img = new Uint8Array(sw * sh)
      for (let p = 0; p < img.length; p++) img[p] = Math.round(0.2126 * rgba[4 * p] + 0.7152 * rgba[4 * p + 1] + 0.0722 * rgba[4 * p + 2])
      if (!first) {first = img.slice(); mask = flat(img, sw, sh) ? ring(sw, sh, 0, DISC_IN) : null}
      last = img
      pairs[i] = new Float32Array(0)
      const at = Math.floor(i / CHUNK) % count, before = Math.floor((i - 1) / CHUNK) % count
      const message = {index: i, img, w: sw, h: sh, mask, corners: BUDGET.corners}
      if (i && i % CHUNK === 0 && before !== at) await work.send(before, message, [])
      await work.send(at, {...message, first: !i || (i % CHUNK === 0 && before !== at)}, [])
      onProgress(Math.min(1, t.at(-1) / Math.max(end - start, 1e-6)))
    }
    await work.drain()
  } finally {
    work.close()
  }
  const out = first && ring(sw, sh, DISC_OUT)
  const disc = Boolean(mask) && first.reduce((acc, v, p) => acc + (out[p] ? Math.abs(last[p] - v) : 0), 0) / out.reduce((a, b) => a + b, 0) < DISC_FLAT
  return {t: Float64Array.from(t), pairs, disc}
}

// [DOC: local-motion-world]
export const matrix = ([tx, ty, th, ls], [w, h]) => {
  const s = Math.exp(ls), a = s * Math.cos(th), b = s * Math.sin(th), cx = w / 2, cy = h / 2
  return [a, -b, cx + tx - a * cx + b * cy, b, a, cy + ty - b * cx - a * cy]
}

const column = (rows, k) => Float64Array.from(rows, row => row[k])

export const world = (flow, p, strength, size, n) => {
  const t = flow.t, [c0x, c0y] = [size[0] / 2, size[1] / 2], m = t.length
  const sigma = m > 1 ? SLOW * (m - 1) / Math.max(t[m - 1] - t[0], 1e-6) : 1
  const cx = column(p, 0).map(v => v + c0x), cy = column(p, 1).map(v => v + c0y)
  const [sx, sy, a, s] = [cx, cy, column(p, 2), column(p, 3)].map(v => gaussianFilter1d(v, sigma))
  const q = p.map(([, , th, ls], k) => {
    const dx = cx[k] - sx[k], dy = cy[k] - sy[k], cos = Math.cos(a[k]), sin = Math.sin(a[k]), z = Math.exp(-s[k])
    return [sx[k] + (cos * dx + sin * dy) * z - c0x, sy[k] + (-sin * dx + cos * dy) * z - c0y, th - a[k], ls - s[k]]
  })
  const cols = [0, 1, 2, 3].map(k => column(q, k))
  const track = Array.from({length: n}, (_, i) => matrix(cols.map(v => interp(i / FPS, t, v)), size))
  const sides = flow.disc ? DISC_SIDES : 4, nrm = new Float64Array(m * sides * 2), off = new Float64Array(m * sides)
  q.forEach((row, k) => {
    const h = matrix(row, size)
    if (flow.disc) {
      for (let e = 0; e < sides; e++) {
        const ang = 2 * Math.PI * e / sides, ux = -Math.cos(ang) / Math.cos(Math.PI / sides), uy = -Math.sin(ang) / Math.cos(Math.PI / sides)
        nrm.set([ux, uy], 2 * (k * sides + e))
        off[k * sides + e] = (c0x + row[0]) * ux + (c0y + row[1]) * uy - DISC_SAFE * Math.min(...size) / 2 * Math.exp(row[3])
      }
      return
    }
    const quad = [[0, 0], [size[0], 0], [size[0], size[1]], [0, size[1]]].map(([x, y]) => [h[0] * x + h[1] * y + h[2], h[3] * x + h[4] * y + h[5]])
    const mx = quad.reduce((acc, v) => acc + v[0], 0) / 4, my = quad.reduce((acc, v) => acc + v[1], 0) / 4
    quad.forEach(([x, y], e) => {
      const [x1, y1] = quad[(e + 1) % 4], len = Math.hypot(x1 - x, y1 - y)
      let nx = -(y1 - y) / len, ny = (x1 - x) / len
      const sign = Math.sign((mx - x) * nx + (my - y) * ny)
      nx *= sign; ny *= sign
      nrm.set([nx, ny], 2 * (k * sides + e))
      off[k * sides + e] = nx * x + ny * y
    })
  })
  return {t: Float64Array.from(t), p: q, size, ft: Float64Array.from(t, v => v * FPS), track, nrm, off, sides, strength, disc: Boolean(flow.disc)}
}

// [DOC: local-motion-world]
export const placer = (at, {t, p, size}) => frame => {
  const [x, y, side] = at(frame), s = frame / FPS
  let i = 0
  while (i < t.length && t[i] < s) i++
  i = Math.min(Math.max(i, 1), t.length - 1)
  const q = p[s - t[i - 1] < t[i] - s ? i - 1 : i], [a, b, c, d, e, f] = matrix(q, size), det = a * e - b * d
  const u = x - c, v = y - f
  return [(e * u - b * v) / det, (a * v - d * u) / det, side * Math.exp(-q[3]), -q[2]]
}
