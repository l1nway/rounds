import {SHADERS} from './fill-gl.js'
import {matrix} from './motion.js'

const FPS = 30
const FEATHER = 8
const RIM = 1
const DISC_SAFE = 0.98
// [DOC: motion-budget]
export const BUDGET = {reach: 0.5, canvas: 4096}

const inverse = ([a, b, c, d, e, f]) => {
  const det = a * e - b * d
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det]
}

const median = values => {
  const v = [...values].sort((a, b) => a - b), mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

const nearest = (t, s) => {
  let i = 0
  while (i < t.length && t[i] < s) i++
  i = Math.min(Math.max(i, 1), t.length - 1)
  return s - t[i - 1] < t[i] - s ? i - 1 : i
}

// [DOC: local-fill]
export const createFill = (g, {size, rate, n, world, base, start = 0, times = Array.from({length: n}, (_, i) => (start + i) / rate)}) => {
  const {gl} = g, run = Object.fromEntries(Object.entries(SHADERS).map(([key, text]) => [key, g.program(text)]))
  const fps = rate ?? (n - 1) / Math.max(times[n - 1] - times[0], 1e-6), reach = Math.max(1, Math.ceil(BUDGET.reach * fps)), slots = 2 * reach + 1, [fw, fh] = world.size
  const rows = times.map(s => base(s * FPS))
  const inv = times.map(s => inverse(matrix(world.p[nearest(world.t, s)], world.size)))
  const table = new Float32Array(n * 12)
  rows.forEach((row, i) => {
    table.set([row[0], row[1], row[2], 0], 4 * i)
    table.set([...inv[i].slice(0, 3), 0], 4 * (n + i))
    table.set([...inv[i].slice(3), 0], 4 * (2 * n + i))
  })
  const params = g.texture(n, 3, gl.RGBA32F)
  g.upload(params, {data: table}, n, 3)
  const lo = [0, 1].map(a => Math.min(...rows.map(r => r[a] - r[2] / 2))), hi = [0, 1].map(a => Math.max(...rows.map(r => r[a] + r[2] / 2)))
  const scale = Math.min(size / median(rows.map(r => r[2])), BUDGET.canvas / Math.max(hi[0] - lo[0], hi[1] - lo[1]))
  const csize = [0, 1].map(a => Math.ceil((hi[a] - lo[a]) * scale) + 1)
  const canvas = g.texture(...csize, gl.RGBA16F), ring = g.texture(size, size, g.format, slots)
  const [good, boxed, keep, out, a, b] = Array.from({length: 6}, () => g.texture(size, size))
  const donors = g.texture(2 * reach, 1, gl.RGBA32F), levels = [a], rests = [null]
  for (let s = size; s > 2;) {s = Math.ceil(s / 2); levels.push(g.texture(s, s)); rests.push(g.texture(s, s))}
  const common = {frame: ['2f', fw, fh], disc: ['1i', world.disc ? 1 : 0], size: ['1f', size], rim: ['1f', RIM], safe: ['1f', DISC_SAFE]}
  const inputs = extra => ({params, ...extra})
  const bad = i => [0, size - 1].some(qx => [0, size - 1].some(qy => {
    const [x, y, side] = rows[i], v = [(qx + 0.5) / size - 0.5, (qy + 0.5) / size - 0.5], m = inv[i]
    const px = v[0] * side + x, py = v[1] * side + y, sx = m[0] * px + m[1] * py + m[2], sy = m[3] * px + m[4] * py + m[5]
    return world.disc ? Math.hypot(sx - fw / 2, sy - fh / 2) > DISC_SAFE * Math.min(fw, fh) / 2 : sx < RIM || sx > fw - RIM || sy < RIM || sy > fh - RIM
  }))
  const square = [size, size]
  let entries = [], next = start, emitted = start, painted = 0

  const fill = (i, slot, list) => {
    g.pass(run.MASK, good, square, inputs(), {...common, k: ['1i', i]})
    g.pass(run.BOX, boxed, square, {src: good, mask: good}, {axis: ['1i', 0], radius: ['1i', FEATHER], last: ['1i', 0]})
    g.pass(run.BOX, keep, square, {src: boxed, mask: good}, {axis: ['1i', 1], radius: ['1i', FEATHER], last: ['1i', 1]})
    const data = new Float32Array(8 * reach)
    list.forEach((j, d) => data.set([j - start, j % slots], 4 * d))
    g.upload(donors, {data}, 2 * reach, 1)
    g.pass(run.FILL, [a, b], square, inputs({ring, donors, keep, canvas}), {...common, k: ['1i', i], self: ['1i', slot], count: ['1i', list.length], paint: ['1i', 1], cinfo: ['3f', lo[0], lo[1], scale], csize: ['2f', ...csize]})
    for (let l = 1; l < levels.length; l++) g.pass(run.POOL, levels[l], [levels[l].w, levels[l].h], {src: levels[l - 1]})
    const top = levels.length - 1
    g.pass(run.BASE, rests[top], [levels[top].w, levels[top].h], {src: levels[top]})
    for (let l = top - 1; l >= 0; l--) {
      g.pass(run.UP, l ? rests[l] : out, [levels[l].w, levels[l].h], {src: levels[l], coarse: rests[l + 1], keep, extra: b, ring}, {last: ['1i', l ? 0 : 1], self: ['1i', slot]})
    }
  }

  const write = (i, slot) => {
    const [x, y, side] = rows[i], [x0, y0] = [x - side / 2 - lo[0], y - side / 2 - lo[1]].map(v => Math.max(Math.trunc(v * scale), 0))
    const [x1, y1] = [x + side / 2 - lo[0], y + side / 2 - lo[1]].map((v, a) => Math.min(Math.ceil(v * scale), csize[a]))
    if (x1 <= x0 || y1 <= y0) return
    g.pass(run.WRITE, canvas, csize, inputs({ring}), {...common, k: ['1i', i], self: ['1i', slot], cinfo: ['3f', lo[0], lo[1], scale], cwin: ['3f', x, y, side]}, {scissor: [x0, y0, x1 - x0, y1 - y0]})
  }

  const emit = (e, onFrame) => {
    const list = entries.filter(j => j !== e).sort((p, q) => Math.abs(p - e) - Math.abs(q - e) || p - q), slot = e % slots, i = e - start
    entries = entries.filter(j => j >= e + 1 - reach)
    if (bad(i)) {fill(i, slot, list); painted++}
    else g.pass(run.LAYER, out, square, {ring}, {self: ['1i', slot]})
    write(i, slot)
    onFrame(e, out)
  }

  const push = (tex, onFrame) => {
    const k = next++
    g.pass(run.COPY, ring, square, {src: tex}, {}, {layer: k % slots})
    entries.push(k)
    while (k - emitted >= reach) emit(emitted++, onFrame)
  }
  const flush = onFrame => {while (entries.length && emitted <= entries.at(-1)) emit(emitted++, onFrame)}
  const free = () => [params, canvas, ring, good, boxed, keep, out, a, b, donors, ...levels.slice(1), ...rests.slice(1)].forEach(g.free)
  return {push, flush, free, reach, stats: () => ({painted, canvas: csize, bytes: g.bytes()})}
}
