import highsLoader from 'highs'
import wasm from 'highs/runtime?url'

const FPS = 30
const WEIGHTS = [10, 1, 100]
const ZOOM_WEIGHT = 8
const CENTER = 0.2
const FRAMING = 0.5
const SAFE_EXIT = 1000
const CIRCLE_EXIT = 20000
const SAFE = 0.85
const FILL = 0.55
const SIDES = 8
const PAN_SPEED = 0.5
const PAN_ACCEL = 1.5
const ZOOM_SPEED = 0.12
const GAP_HOLD = 1
const GAP_LEAD = 1
const TIME_LIMIT = 30
// [DOC: local-stabilization]
const EDGE_CAP = 24, EDGE_DEEP = 1000, PAN_SOFT = 3, STAB_ACCEL = 2, CROP_SHARE = 0.5, OUT_SIZE = 640
const DIFFS = [null, [-1, 1], [1, -2, 1], [-1, 3, -3, 1]]

let solver = null
const load = () => solver ??= highsLoader({locateFile: () => wasm})

const hold = (on, rate) => {
  const out = new Uint8Array(on.length - 1), t = []
  on.forEach((v, i) => v && t.push(i))
  for (let k = 0; k + 1 < t.length; k++) if (t[k + 1] - t[k] > GAP_HOLD * rate) out.fill(1, t[k], Math.max(t[k], t[k + 1] - Math.round(GAP_LEAD * rate)))
  return out
}

const sparse = () => {
  const m = {starts: [0], indices: [], values: [], lower: [], upper: []}
  m.row = (entries, lo, hi) => {
    const merged = new Map()
    for (const [col, val] of entries) merged.set(col, (merged.get(col) ?? 0) + val)
    merged.forEach((val, col) => {m.indices.push(col); m.values.push(val)})
    m.starts.push(m.indices.length)
    m.lower.push(lo)
    m.upper.push(hi)
  }
  return m
}

// [DOC: camera-lp]
export const lp = async (on, px, py, r, box, lo, rate, zoom, edge = null) => {
  const highs = await load()
  const n = on.length, q = FPS / rate, dt = 1 / rate, X = 0, Y = n, Z = 2 * n
  const sel = []
  on.forEach((v, i) => v && sel.push(i))
  const fit = sel.filter(i => r[i] < SAFE)
  const held = edge ? new Uint8Array(n) : hold(on, rate)
  const diff = (axis, order, j, s = 1) => DIFFS[order].map((c, k) => [axis + j + k, s * c])
  const res = []
  for (const [axis, k] of [[X, 1], [Y, 1], [Z, ZOOM_WEIGHT]]) WEIGHTS.forEach((w, i) => {
    for (let j = 0; j < n - i - 1; j++) res.push([diff(axis, i + 1, j), 0, k * w / q ** i, i || !held[j] ? Infinity : 0])
  })
  sel.forEach(i => res.push([[[X + i, 1]], px[i], CENTER * q, Infinity]))
  sel.forEach(i => res.push([[[Y + i, 1]], py[i], CENTER * q, Infinity]))
  if (zoom) sel.forEach(i => res.push([[[Z + i, 1]], r[i] / FILL, FRAMING * q, Infinity]))
  const t = res.length, m = fit.length, u = edge ? n : 0, v = edge ? 4 * n - 4 : 0
  const EP = 3 * n, EM = EP + t, S1 = EM + t, S2 = S1 + m, U = S2 + m, W = U + u, V = W + u, cols = V + v
  const a = sparse()
  res.forEach(([entries, target], k) => a.row([...entries, [EP + k, -1], [EM + k, 1]], target, target))
  const vh = 2 * PAN_SPEED * dt, ah = 2 * PAN_ACCEL * (edge ? STAB_ACCEL : 1) * dt * dt, zh = ZOOM_SPEED * dt
  let capRow = 0
  for (const [axis, order, shift, cap] of [[X, 1, 0, vh], [Y, 1, 0, vh], [X, 2, 1, ah], [Y, 2, 1, ah], [Z, 1, 0, zh]]) {
    for (const s of [1, -1]) for (let j = 0; j < n - order; j++, capRow++) {
      a.row([...diff(axis, order, j, s), [Z + j + shift, -cap], ...capRow < v ? [[V + capRow, -1]] : []], -Infinity, 0)
    }
  }
  // [DOC: edge-fill]
  if (box) for (const [axis, sign, hi] of [[X, -1, 0], [X, 1, box[0]], [Y, -1, 0], [Y, 1, box[1]]]) {
    for (let j = 0; j < n; j++) a.row([[axis + j, sign], [Z + j, 1]], -Infinity, hi)
  }
  const ck = Math.cos(Math.PI / SIDES)
  for (let d = 0; d < SIDES; d++) {
    const ux = Math.cos(2 * Math.PI * d / SIDES), uy = Math.sin(2 * Math.PI * d / SIDES)
    fit.forEach((i, f) => a.row([[X + i, -ux], [Y + i, -uy], [Z + i, -ck * SAFE], [S1 + f, -1], [S2 + f, -1]], -Infinity, -(ux * px[i] + uy * py[i] + ck * r[i])))
  }
  fit.forEach((i, f) => a.row([[Z + i, -ck * (1 - SAFE)], [S1 + f, 1]], -Infinity, 0))
  // [DOC: local-stabilization]
  edge?.j.forEach((j, k) => a.row([[X + j, -edge.nx[k]], [Y + j, -edge.ny[k]], [Z + j, 1], [U + j, -1], [W + j, -1]], -Infinity, -edge.c[k]))
  const e = edge ? edge.cost * q : 0
  const cost = new Float64Array(cols), lower = new Float64Array(cols), upper = new Float64Array(cols).fill(Infinity)
  res.forEach(([, , w, ub], k) => {cost[EP + k] = cost[EM + k] = w; upper[EP + k] = upper[EM + k] = ub})
  cost.fill(zoom ? 0 : -CROP_SHARE * e, Z, EP).fill(SAFE_EXIT * q, S1, S2).fill(CIRCLE_EXIT * q, S2, U)
  cost.fill(e, U, W).fill(EDGE_DEEP * e, W, V).fill(PAN_SOFT * e, V)
  lower.fill(box ? 0 : -Infinity, X, Z).fill(lo, Z, EP)
  if (box) upper.fill(box[0], X, Y).fill(box[1], Y, Z)
  upper.fill(1, Z, EP).fill(EDGE_CAP / (OUT_SIZE / 2), U, W)
  const rows = a.lower.length
  return highs.withModel(model => {
    model.options.set('time_limit', TIME_LIMIT)
    model.passModel({
      numCols: cols, numRows: rows, colCost: cost, colLower: lower, colUpper: upper, rowLower: a.lower, rowUpper: a.upper,
      matrix: {format: 'csr', numRows: rows, numCols: cols, starts: Int32Array.from(a.starts), indices: Int32Array.from(a.indices), values: Float64Array.from(a.values)}
    })
    model.run()
    if (model.getModelStatus() !== highs.constants.modelStatus.optimal) return null
    const v = model.getSolution().colValue
    return Array.from({length: n}, (_, j) => [v[X + j], v[Y + j], v[Z + j]])
  })
}
