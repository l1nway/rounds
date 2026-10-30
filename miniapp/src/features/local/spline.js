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

export const roundEven = x => x - Math.floor(x) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x)

export const interp =(x, xs, ys) => {
  const n = xs.length
  if (x <= xs[0]) return ys[0]
  if (x >= xs[n - 1]) return ys[n - 1]
  let lo = 0, hi = n - 1
  while (hi - lo > 1) {const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid}
  return (ys[hi] - ys[lo]) / (xs[hi] - xs[lo]) * (x - xs[lo]) + ys[lo]
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
