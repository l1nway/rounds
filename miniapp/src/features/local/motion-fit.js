import {roundEven} from './spline.js'

const FPS = 30
const DBL_MIN = 2.2250738585072014e-308
const THRESHOLD = 1.5
const MAX_ITERS = 2000
const CONFIDENCE = 0.995
const INLIERS = 24
const EXCLUDE = 1.2
const COEFF = 4164903690n
const MASK = (1n << 64n) - 1n
const f32 = Math.fround

const rng = () => {
  let state = MASK
  return count => {
    state = ((state & 0xffffffffn) * COEFF + (state >> 32n)) & MASK
    return Number((state & 0xffffffffn) % BigInt(count))
  }
}

const update = (p, ep, points, iters) => {
  const num = Math.log(Math.max(1 - p, DBL_MIN)), denom = 1 - (1 - ep) ** points
  if (denom < DBL_MIN) return 0
  const d = Math.log(denom)
  return d >= 0 || -num >= iters * -d ? iters : roundEven(num / d)
}

const kernel = (m, i, j) => {
  const [x1, y1, X1, Y1] = m.subarray(4 * i, 4 * i + 4), [x2, y2, X2, Y2] = m.subarray(4 * j, 4 * j + 4)
  const d = 1 / ((x1 - x2) * (x1 - x2) + (y1 - y2) * (y1 - y2))
  const s0 = d * ((X1 - X2) * (x1 - x2) + (Y1 - Y2) * (y1 - y2))
  const s1 = d * ((Y1 - Y2) * (x1 - x2) - (X1 - X2) * (y1 - y2))
  const s2 = d * ((Y1 - Y2) * (x1 * y2 - x2 * y1) - (X1 * y2 - X2 * y1) * (y1 - y2) - (X1 * x2 - X2 * x1) * (x1 - x2))
  const s3 = d * (-(X1 - X2) * (x1 * y2 - x2 * y1) - (Y1 * x2 - Y2 * x1) * (x1 - x2) - (Y1 * y2 - Y2 * y1) * (y1 - y2))
  return [s0, -s1, s2, s1, s0, s3]
}

const inliers = (m, h, mask) => {
  const [a, b, c, d, e, f] = h.map(f32), t = f32(THRESHOLD * THRESHOLD)
  let good = 0
  for (let k = 0; k < mask.length; k++) {
    const x = m[4 * k], y = m[4 * k + 1]
    const u = f32(f32(f32(f32(a * x) + f32(b * y)) + c) - m[4 * k + 2]), v = f32(f32(f32(f32(d * x) + f32(e * y)) + f) - m[4 * k + 3])
    mask[k] = f32(f32(u * u) + f32(v * v)) <= t
    good += mask[k]
  }
  return good
}

const leastSquares = (m, mask) => {
  const A = Array.from({length: 4}, () => new Float64Array(5))
  for (let k = 0; k < mask.length; k++) if (mask[k]) {
    const x = m[4 * k], y = m[4 * k + 1]
    for (const [row, rhs] of [[[x, -y, 1, 0], m[4 * k + 2]], [[y, x, 0, 1], m[4 * k + 3]]]) {
      for (let i = 0; i < 4; i++) {for (let j = 0; j < 4; j++) A[i][j] += row[i] * row[j]; A[i][4] += row[i] * rhs}
    }
  }
  for (let c = 0; c < 4; c++) {
    const p = A.slice(c).reduce((best, row, i) => Math.abs(row[c]) > Math.abs(A[best][c]) ? c + i : best, c)
    ;[A[c], A[p]] = [A[p], A[c]]
    for (let r = 0; r < 4; r++) if (r !== c) {const k = A[r][c] / A[c][c]; for (let j = c; j < 5; j++) A[r][j] -= k * A[c][j]}
  }
  const [a, b, tx, ty] = A.map((row, i) => row[4] / row[i])
  return [a, -b, tx, b, a, ty]
}

// [DOC: local-motion-fit]
export const similarity = m => {
  const count = m.length / 4, uniform = rng(), mask = new Uint8Array(count)
  let best = null, bestMask = null, most = 0, iters = MAX_ITERS
  for (let it = 0; it < iters; it++) {
    const i = uniform(count)
    let j = uniform(count)
    while (j === i) j = uniform(count)
    const h = kernel(m, i, j)
    if (!h.every(Number.isFinite)) continue
    const good = inliers(m, h, mask)
    if (good > Math.max(most, 1)) {
      best = h; bestMask = mask.slice(); most = good
      iters = update(CONFIDENCE, (count - good) / count, 2, iters)
    }
  }
  return best && {h: leastSquares(m, bestMask), inliers: most}
}

const subject = (t, track) => {
  if (!track) return null
  const n = track.present.length, j = Math.min(Math.max(roundEven(t * FPS), 0), n - 1)
  const c = [track.cx[j], track.cy[j], track.r[j]]
  return track.present[j] && c.every(Number.isFinite) ? c : null
}

const step = (pairs, circle) => {
  let m = pairs
  if (circle) {
    const keep = []
    for (let k = 0; k < m.length; k += 4) if (Math.hypot(m[k] - circle[0], m[k + 1] - circle[1]) > EXCLUDE * circle[2]) keep.push(...m.subarray(k, k + 4))
    m = Float32Array.from(keep)
  }
  if (m.length / 4 < INLIERS) return null
  const fit = similarity(Float32Array.from(m))
  return fit && fit.inliers >= INLIERS ? fit.h : null
}

// [DOC: local-motion-fit]
export const params = (flow, [w, h], track = null, cuts = []) => {
  const bounds = cuts.map(c => (c - 0.5) / FPS), cx = w / 2, cy = h / 2
  let [a, b, c, d, e, f] = [1, 0, 0, 0, 1, 0]
  return Array.from(flow.t, (t, i) => {
    const prev = flow.t[i - 1], s = i && !bounds.some(x => x > prev && x <= t) ? step(flow.pairs[i], subject(t, track)) : null
    if (s) {
      const det = s[0] * s[4] - s[1] * s[3], ia = s[4] / det, ib = -s[1] / det, id = -s[3] / det, ie = s[0] / det
      const ic = -(ia * s[2] + ib * s[5]), iff = -(id * s[2] + ie * s[5])
      ;[a, b, c, d, e, f] = [a * ia + b * id, a * ib + b * ie, a * ic + b * iff + c, d * ia + e * id, d * ib + e * ie, d * ic + e * iff + f]
    }
    return [a * cx + b * cy + c - cx, d * cx + e * cy + f - cy, Math.atan2(d, a), Math.log(Math.hypot(a, d))]
  })
}
