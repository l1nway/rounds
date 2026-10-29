const HAMPEL = 11
const JUMP = 2
const JUMP_SIZE = 2
const SPIKE = 1
const FILL = 0.55
const OUT_SIZE = 640
const FPS = 30

// [DOC: camera-smooth]
export const gaussianFilter1d = (v, sigma, truncate = 4.0) => {
  const radius = Math.round(truncate * sigma), n = v.length
  const kernel = new Float64Array(2 * radius + 1)
  let sum = 0
  for (let i = 0; i <= 2 * radius; i++) {
    const x = i - radius, val = Math.exp(-(x * x) / (2 * sigma * sigma))
    kernel[i] = val; sum += val
  }
  for (let i = 0; i <= 2 * radius; i++) kernel[i] /= sum
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let k = -radius; k <= radius; k++) acc += v[Math.max(0, Math.min(n - 1, i + k))] * kernel[k + radius]
    out[i] = acc
  }
  return out
}

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

// [DOC: camera-spline]
export class CubicSpline {
  constructor(xs, ys) {
    const n = xs.length, dim = Array.isArray(ys[0]) ? ys[0].length : 0
    this.xs = Float64Array.from(xs); this.n = n; this.dim = dim
    if (dim) {this.splines = Array.from({length: dim}, (_, d) => new CubicSpline(xs, ys.map(y => y[d]))); return}
    const y = Float64Array.from(ys); this.ys = y
    if (n < 2) return
    const dx = new Float64Array(n - 1), slope = new Float64Array(n - 1)
    for (let i = 0; i < n - 1; i++) {dx[i] = xs[i + 1] - xs[i]; slope[i] = (y[i + 1] - y[i]) / dx[i]}
    const s = new Float64Array(n)
    if (n === 2) {
      s[0] = slope[0]; s[1] = slope[0]
    } else if (n === 3) {
      const a10 = dx[1], a11 = 2 * (dx[0] + dx[1]), a12 = dx[0], b0 = 2 * slope[0], b1 = 3 * (dx[0] * slope[1] + dx[1] * slope[0]), b2 = 2 * slope[1], det = a11 - a12 - a10
      s[0] = (b0 * (a11 - a12) - (b1 - a12 * b2)) / det; s[1] = (b1 - a12 * b2 - b0 * a10) / det; s[2] = b2 - s[1]
    } else {
      const D = new Float64Array(n), U = new Float64Array(n - 1), L = new Float64Array(n - 1), B = new Float64Array(n)
      for (let i = 1; i < n - 1; i++) {
        L[i - 1] = dx[i]; D[i] = 2 * (dx[i - 1] + dx[i]); U[i] = dx[i - 1]
        B[i] = 3 * (dx[i] * slope[i - 1] + dx[i - 1] * slope[i])
      }
      const d0 = xs[2] - xs[0], dn = xs[n - 1] - xs[n - 3]
      D[0] = dx[1]; U[0] = d0; B[0] = ((dx[0] + 2 * d0) * dx[1] * slope[0] + dx[0] ** 2 * slope[1]) / d0
      D[n - 1] = dx[n - 2]; L[n - 2] = dn; B[n - 1] = (dx[n - 2] ** 2 * slope[n - 3] + (2 * dn + dx[n - 2]) * dx[n - 3] * slope[n - 2]) / dn
      for (let i = 1; i < n; i++) {const m = L[i - 1] / D[i - 1]; D[i] -= m * U[i - 1]; B[i] -= m * B[i - 1]}
      s[n - 1] = B[n - 1] / D[n - 1]
      for (let i = n - 2; i >= 0; i--) s[i] = (B[i] - U[i] * s[i + 1]) / D[i]
    }
    this.b = s.subarray(0, n - 1); this.c = new Float64Array(n - 1); this.d = new Float64Array(n - 1)
    for (let i = 0; i < n - 1; i++) {
      this.c[i] = (3 * slope[i] - 2 * s[i] - s[i + 1]) / dx[i]
      this.d[i] = (s[i] + s[i + 1] - 2 * slope[i]) / (dx[i] ** 2)
    }
  }
  at(x) {
    if (this.dim) return this.splines.map(s => s.at(x))
    if (this.n === 1) return this.ys[0]
    let lo = 0, hi = this.n - 1
    if (x <= this.xs[0]) lo = 0
    else if (x >= this.xs[hi]) lo = hi - 1
    else while (hi - lo > 1) {const mid = (lo + hi) >> 1; if (this.xs[mid] <= x) lo = mid; else hi = mid}
    const dx = x - this.xs[lo]
    return this.ys[lo] + this.b[lo] * dx + this.c[lo] * dx * dx + this.d[lo] * dx * dx * dx
  }
}

// [DOC: square-source]
export const still = (n, width, height) => {
  const row = [width / 2, height / 2, Math.min(width, height)]
  return Array.from({length: n}, () => row.slice())
}

// [DOC: camera-path]
export const solve = (track, width, height, cuts = [], fps = FPS, zoom = false) => {
  const s = Math.min(width, height) / 2, n = track.present.length
  const cx = Float64Array.from(track.cx, v => v / s)
  const cy = Float64Array.from(track.cy, v => v / s)
  const r = Float64Array.from(track.r, v => v / s)
  const on = track.present.map((p, i) => Boolean(p) && isFinite(cx[i] + cy[i] + r[i]))
  const box = [width / s, height / s], half = [width / (2 * s), height / (2 * s)]
  const lo = zoom ? Math.min(OUT_SIZE / 2, s) / s : 1
  const edges = Array.from(new Set([0, ...cuts.filter(c => c > 0 && c < n), n])).sort((a, b) => a - b)
  const shots = []
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i], b = edges[i + 1], len = b - a
    const [sOn, sX, sY, sR] = [on.slice(a, b), cx.slice(a, b), cy.slice(a, b), r.slice(a, b)]
    const sCentre = Array.from({length: len}, () => half)
    const cleaned = clean(sOn, sX, sY, sR, fps)
    shots.push(...fallback(cleaned, sX, sY, sR, sCentre, box, lo, fps))
  }
  return shots.map(([x, y, z]) => [x * s, y * s, z * 2 * s])
}

// [DOC: path-sampler]
export const sampler = (path, cuts = []) => {
  const n = path.length
  const edges = Array.from(new Set([0, ...cuts.filter(c => c > 0 && c < n), n])).sort((a, b) => a - b)
  const shots = []
  for (let i = 0; i < edges.length - 1; i++) {
    const a = edges[i], b = edges[i + 1]
    const xs = Array.from({length: b - a}, (_, k) => a + k)
    shots.push({a, b, spline: b - a > 1 ? new CubicSpline(xs, path.slice(a, b)) : null})
  }
  return frame => {
    const k = Math.round(frame)
    let idx = 0
    for (let i = 0; i < edges.length - 2; i++) if (k >= edges[i + 1]) idx = i + 1
    const {a, b, spline} = shots[idx]
    return spline ? spline.at(Math.max(a, Math.min(b - 1, frame))) : path[a]
  }
}
