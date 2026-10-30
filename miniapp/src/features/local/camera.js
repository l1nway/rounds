import {lp} from './camera-lp.js'
import {CubicSpline, gaussianFilter1d, roundEven} from './spline.js'

export {sampler} from './spline.js'

const HAMPEL = 11
const STEP = 2
const JUMP = 2
const JUMP_SIZE = 2
const SPIKE = 1
const FILL = 0.55
const OUT_SIZE = 640
const FPS = 30
// [DOC: local-stabilization]
const STAB_CROP = 0.2
const EDGE_EXIT = [300, 0.3]

// [DOC: camera-hampel]
export const hampel = v => {
  const k = HAMPEL >> 1, n = v.length
  const pad = new Float64Array(n + 2 * k)
  for (let i = 0; i < k; i++) {pad[k - 1 - i] = v[1 + i]; pad[k + n + i] = v[n - 2 - i]}
  pad.set(v, k)
  const out = new Float64Array(n), win = new Float64Array(2 * k + 1), diffs = new Float64Array(2 * k + 1)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= 2 * k; j++) win[j] = pad[i + j]
    win.sort()
    const med = win[k]
    for (let j = 0; j <= 2 * k; j++) diffs[j] = Math.abs(win[j] - med)
    diffs.sort()
    out[i] = Math.abs(v[i] - med) > 3 * 1.4826 * diffs[k] ? med : v[i]
  }
  return out
}

// [DOC: camera-clean]
export const clean = (on, px, py, r, fps = FPS) => {
  const t = []
  for (let i = 0; i < on.length; i++) if (on[i]) t.push(i)
  if (t.length > HAMPEL) {
    const pt = [new Float64Array(t.length), new Float64Array(t.length), new Float64Array(t.length)]
    t.forEach((idx, i) => {pt[0][i] = px[idx]; pt[1][i] = py[idx]; pt[2][i] = r[idx]})
    const [cx, cy, cr] = pt.map(hampel)
    t.forEach((idx, i) => {px[idx] = cx[i]; py[idx] = cy[i]; r[idx] = cr[i]})
  }
  if (t.length < 2) return on.slice()
  const m = t.length - 1, jump = new Uint8Array(m)
  for (let i = 0; i < m; i++) {
    const gap = t[i + 1] - t[i], a = r[t[i]], b = r[t[i + 1]]
    const big = Math.max(a, b), small = Math.max(Math.min(a, b), 1e-6)
    if (Math.hypot(px[t[i + 1]] - px[t[i]], py[t[i + 1]] - py[t[i]]) > JUMP * big * gap || (big > JUMP_SIZE * small && gap === 1)) jump[i] = 1
  }
  const run = new Int32Array(t.length)
  for (let i = 0; i < m; i++) run[i + 1] = run[i] + jump[i]
  const num = run[run.length - 1] + 1, lens = new Int32Array(num)
  for (let i = 0; i < run.length; i++) lens[run[i]]++
  const bad = new Uint8Array(num)
  for (let i = 0; i < num; i++) {
    const prev = i > 0 ? lens[i - 1] : 0, next = i + 1 < num ? lens[i + 1] : 0
    if (lens[i] < SPIKE * fps && lens[i] < Math.max(prev, next)) bad[i] = 1
  }
  const out = on.slice()
  for (let i = 0; i < t.length; i++) if (bad[run[i]]) out[t[i]] = false
  return out
}

export const clamp = (p, box, lo) => p.map(([x, y, z]) => {
  const h = Math.min(1, Math.max(lo, z))
  return box ? [Math.min(box[0] - h, Math.max(h, x)), Math.min(box[1] - h, Math.max(h, y)), h] : [x, y, h]
})

export const fallback = (on, px, py, r, centre, box, lo, fps = FPS) => {
  const n = on.length, t = []
  for (let i = 0; i < n; i++) if (on[i]) t.push(i)
  if (!t.length) {
    const [c0, c1] = [gaussianFilter1d(centre.map(p => p[0]), fps), gaussianFilter1d(centre.map(p => p[1]), fps)]
    return clamp(Array.from({length: n}, (_, i) => [c0[i], c1[i], 1]), box, lo)
  }
  const interp = vals => {
    const res = new Float64Array(n)
    for (let i = 0, k = 0; i < n; i++) {
      if (i <= t[0]) res[i] = vals[t[0]]
      else if (i >= t[t.length - 1]) res[i] = vals[t[t.length - 1]]
      else {
        while (k + 1 < t.length && t[k + 1] < i) k++
        const t0 = t[k], t1 = t[k + 1]
        res[i] = vals[t0] + (vals[t1] - vals[t0]) * ((i - t0) / (t1 - t0))
      }
    }
    return res
  }
  const [sx, sy] = [gaussianFilter1d(interp(px), fps), gaussianFilter1d(interp(py), fps)]
  const sorted = t.map(i => r[i]).sort((a, b) => a - b)
  const z = sorted[sorted.length >> 1] / FILL
  return clamp(Array.from({length: n}, (_, i) => [sx[i], sy[i], z]), box, lo)
}

const edgeOf = (bound, last) => {
  if (!bound) return null
  const {ft, nrm, off, sides, cost} = bound, j = [], nx = [], ny = [], c = []
  ft.forEach((f, k) => {
    const at = Math.min(Math.max(roundEven(f / STEP), 0), last)
    for (let e = 0; e < sides; e++) {j.push(at); nx.push(nrm[2 * (k * sides + e)]); ny.push(nrm[2 * (k * sides + e) + 1]); c.push(off[k * sides + e])}
  })
  return {j, nx, ny, c, cost}
}

const shot = async (on, px, py, r, centre, box, lo, fps, zoom, bound) => {
  const n = on.length, cleaned = clean(on, px, py, r, fps), t = []
  for (let k = 0; k < n + STEP - 1; k += STEP) t.push(k)
  const idx = t.map(k => Math.min(k, n - 1)), pick = v => idx.map(i => v[i])
  const edge = edgeOf(bound, t.length - 1)
  const go = t.length > 7 && (idx.some(i => cleaned[i]) || Boolean(edge))
  const p = go ? await lp(pick(cleaned), pick(px), pick(py), pick(r), box, lo, fps / STEP, zoom, edge) : null
  if (!p) return fallback(cleaned, px, py, r, centre, box, lo, fps)
  const spline = new CubicSpline(t, p)
  return clamp(Array.from({length: n}, (_, i) => spline.at(i)), box, lo)
}

// [DOC: local-stabilization]
const toWorld = (world, cx, cy, r, s, half) => world.track.map(([a, b, c, d, e, f], i) => {
  const x = cx[i], y = cy[i]
  cx[i] = a * x + b * y + c
  cy[i] = d * x + e * y + f
  r[i] *= Math.hypot(a, d)
  return [(c + a * half[0] + b * half[1]) / s, (f + d * half[0] + e * half[1]) / s]
})

const boundOf = (world, s, shot, i, a) => {
  if (!world) return null
  const keep = [], sides = world.sides, pick = (v, w) => keep.flatMap(k => Array.from(v.subarray(k * w, (k + 1) * w)))
  shot.forEach((sh, k) => sh === i && keep.push(k))
  const cost = EDGE_EXIT[0] * (EDGE_EXIT[1] / EDGE_EXIT[0]) ** world.strength
  return {ft: keep.map(k => world.ft[k] - a), nrm: pick(world.nrm, 2 * sides), off: pick(world.off, sides).map(v => v / s), sides, cost}
}

// [DOC: camera-path]
export const solve = async (track, width, height, cuts = [], fps = FPS, zoom = false, world = null) => {
  const s = Math.min(width, height) / 2, n = track.present.length
  const cx = Float64Array.from(track.cx), cy = Float64Array.from(track.cy), r = Float64Array.from(track.r)
  const on = Array.from(track.present, (p, i) => Boolean(p) && isFinite(cx[i] + cy[i] + r[i]))
  const half = [width / 2, height / 2], box = world ? null : [width / s, height / s]
  const centre = world ? toWorld(world, cx, cy, r, s, half) : Array(n).fill([half[0] / s, half[1] / s])
  for (const v of [cx, cy, r]) v.forEach((x, i) => {v[i] = x / s})
  const stab = box || 2 * s <= OUT_SIZE ? 1 : Math.max(OUT_SIZE / (2 * s), 1 - STAB_CROP)
  const lo = zoom ? Math.min(OUT_SIZE / 2, s) / s : stab
  const edges = Array.from(new Set([0, ...cuts.filter(c => c > 0 && c < n), n])).sort((a, b) => a - b)
  const inner = edges.slice(1, -1), shotOf = world && Array.from(world.ft, f => inner.filter(e => e <= roundEven(f)).length)
  const shots = []
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i], b = edges[i + 1], bound = boundOf(world, s, shotOf, i, a)
    shots.push(...await shot(on.slice(a, b), cx.slice(a, b), cy.slice(a, b), r.slice(a, b), centre.slice(a, b), box, lo, fps, zoom, bound))
  }
  return shots.map(([x, y, z]) => [x * s, y * s, z * 2 * s])
}
