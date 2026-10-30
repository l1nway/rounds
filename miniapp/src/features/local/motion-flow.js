// [DOC: local-motion-flow]
export const CORNERS = 600
const QUALITY = 0.01
const SPACING = 8
const WIN = 21
const LEVELS = 3
const ITERS = 30
const EPS = 0.01 ** 2
const MIN_EIG = 1e-4
const BACK = 1
const W_BITS = 14
const ONE = 1 << W_BITS
const FLT_SCALE = 1 / (1 << 20)
const f32 = Math.fround
const reflect = (i, n) => i < 0 ? -i : i >= n ? 2 * n - 2 - i : i
const descale = (x, n) => (x + (1 << (n - 1))) >> n
const roundEven = x => x - Math.floor(x) === 0.5 ? 2 * Math.round(x / 2) : Math.round(x)

const boxSum = (v, w, h) => {
  const row = new Float32Array(w * h), out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    row[y * w + x] = f32(f32(v[y * w + reflect(x - 1, w)] + v[y * w + x]) + v[y * w + reflect(x + 1, w)])
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    out[y * w + x] = f32(f32(row[reflect(y - 1, h) * w + x] + row[y * w + x]) + row[reflect(y + 1, h) * w + x])
  }
  return out
}

export const corners = (img, w, h, mask = null, max = CORNERS) => {
  const scale = 1 / (4 * 3 * 255), xx = new Float32Array(w * h), xy = new Float32Array(w * h), yy = new Float32Array(w * h)
  const at = (x, y) => img[reflect(y, h) * w + reflect(x, w)]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = f32(scale * (at(x + 1, y - 1) - at(x - 1, y - 1) + 2 * (at(x + 1, y) - at(x - 1, y)) + at(x + 1, y + 1) - at(x - 1, y + 1)))
    const dy = f32(scale * (at(x - 1, y + 1) - at(x - 1, y - 1) + 2 * (at(x, y + 1) - at(x, y - 1)) + at(x + 1, y + 1) - at(x + 1, y - 1)))
    xx[y * w + x] = f32(dx * dx); xy[y * w + x] = f32(dx * dy); yy[y * w + x] = f32(dy * dy)
  }
  const [sa, sb, sc] = [xx, xy, yy].map(v => boxSum(v, w, h)), eig = new Float32Array(w * h)
  let top = 0
  for (let k = 0; k < w * h; k++) {
    const a = f32(sa[k] * 0.5), b = sb[k], c = f32(sc[k] * 0.5)
    eig[k] = f32(f32(a + c) - f32(Math.sqrt(f32(f32(f32(a - c) * f32(a - c)) + f32(b * b)))))
    if ((!mask || mask[k]) && eig[k] > top) top = eig[k]
  }
  const thresh = f32(top * QUALITY), found = []
  for (let k = 0; k < w * h; k++) if (!(eig[k] > thresh)) eig[k] = 0
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const k = y * w + x, v = eig[k]
    if (!v || (mask && !mask[k])) continue
    let peak = true
    for (let j = -1; j <= 1 && peak; j++) for (let i = -1; i <= 1; i++) if (eig[k + j * w + i] > v) {peak = false; break}
    if (peak) found.push(k)
  }
  found.sort((a, b) => eig[b] - eig[a] || b - a)
  const gw = Math.ceil(w / SPACING), gh = Math.ceil(h / SPACING), grid = Array.from({length: gw * gh}, () => []), out = []
  for (const k of found) {
    const y = Math.floor(k / w), x = k - y * w, cx = Math.floor(x / SPACING), cy = Math.floor(y / SPACING)
    let good = true
    for (let gy = Math.max(cy - 1, 0); gy <= Math.min(cy + 1, gh - 1) && good; gy++) {
      for (let gx = Math.max(cx - 1, 0); gx <= Math.min(cx + 1, gw - 1) && good; gx++) {
        good = grid[gy * gw + gx].every(([px, py]) => (x - px) ** 2 + (y - py) ** 2 >= SPACING * SPACING)
      }
    }
    if (!good) continue
    grid[cy * gw + cx].push([x, y])
    out.push(x, y)
    if (out.length / 2 === max) break
  }
  return Float32Array.from(out)
}

const pad = (img, w, h) => {
  const pw = w + 2 * WIN, data = new Uint8Array(pw * (h + 2 * WIN))
  for (let y = -WIN; y < h + WIN; y++) for (let x = -WIN; x < w + WIN; x++) data[(y + WIN) * pw + x + WIN] = img[reflect(y, h) * w + reflect(x, w)]
  return data
}

const down = (img, w, h) => {
  const dw = (w + 1) >> 1, dh = (h + 1) >> 1, row = new Int32Array(dw * h), out = new Uint8Array(dw * dh), k = [1, 4, 6, 4, 1]
  for (let y = 0; y < h; y++) for (let x = 0; x < dw; x++) {
    let s = 0
    for (let i = 0; i < 5; i++) s += k[i] * img[y * w + reflect(2 * x - 2 + i, w)]
    row[y * dw + x] = s
  }
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let s = 0
    for (let i = 0; i < 5; i++) s += k[i] * row[reflect(2 * y - 2 + i, h) * dw + x]
    out[y * dw + x] = (s + 128) >> 8
  }
  return out
}

const sharr = (img, w, h) => {
  const pw = w + 2 * WIN, d = new Int16Array(2 * pw * (h + 2 * WIN)), t0 = new Int32Array(w), t1 = new Int32Array(w)
  for (let y = 0; y < h; y++) {
    const r0 = reflect(y - 1, h) * w, r1 = y * w, r2 = reflect(y + 1, h) * w
    for (let x = 0; x < w; x++) {t0[x] = (img[r0 + x] + img[r2 + x]) * 3 + img[r1 + x] * 10; t1[x] = img[r2 + x] - img[r0 + x]}
    for (let x = 0; x < w; x++) {
      const l = reflect(x - 1, w), r = reflect(x + 1, w), o = 2 * ((y + WIN) * pw + x + WIN)
      d[o] = t0[r] - t0[l]
      d[o + 1] = (t1[r] + t1[l]) * 3 + t1[x] * 10
    }
  }
  return d
}

export const pyramid = (img, w, h) => {
  const levels = []
  for (let level = 0; level <= LEVELS; level++) {
    levels.push({raw: img, img: pad(img, w, h), deriv: sharr(img, w, h), w, h})
    if (level < LEVELS) {img = down(img, w, h); w = (w + 1) >> 1; h = (h + 1) >> 1}
  }
  return levels
}

const weights = (a, b) => {
  const w00 = roundEven(f32(f32(f32(1 - a) * f32(1 - b)) * ONE)), w01 = roundEven(f32(f32(a * f32(1 - b)) * ONE))
  const w10 = roundEven(f32(f32(f32(1 - a) * b) * ONE))
  return [w00, w01, w10, ONE - w00 - w01 - w10]
}

const lk = (prev, next, pts, out, status) => {
  const half = f32((WIN - 1) * 0.5), n = pts.length / 2, I = new Int32Array(WIN * WIN), dI = new Int32Array(2 * WIN * WIN)
  status.fill(1)
  for (let level = LEVELS; level >= 0; level--) {
    const {img, deriv, w, h} = prev[level], J = next[level].img, pw = w + 2 * WIN, inv = f32(1 / (1 << level))
    for (let k = 0; k < n; k++) {
      const sx = f32(pts[2 * k] * inv), sy = f32(pts[2 * k + 1] * inv), px = f32(sx - half), py = f32(sy - half)
      let nx = level === LEVELS ? sx : f32(out[2 * k] * 2), ny = level === LEVELS ? sy : f32(out[2 * k + 1] * 2)
      out[2 * k] = nx; out[2 * k + 1] = ny
      const ix = Math.floor(px), iy = Math.floor(py)
      if (ix < -WIN || ix >= w || iy < -WIN || iy >= h) {if (!level) status[k] = 0; continue}
      let [w00, w01, w10, w11] = weights(f32(px - ix), f32(py - iy)), a11 = 0, a12 = 0, a22 = 0
      for (let y = 0; y < WIN; y++) for (let x = 0; x < WIN; x++) {
        const o = (iy + y + WIN) * pw + ix + x + WIN, q = 2 * o, r = 2 * (o + pw), c = y * WIN + x
        I[c] = descale(img[o] * w00 + img[o + 1] * w01 + img[o + pw] * w10 + img[o + pw + 1] * w11, W_BITS - 5)
        const gx = dI[2 * c] = descale(deriv[q] * w00 + deriv[q + 2] * w01 + deriv[r] * w10 + deriv[r + 2] * w11, W_BITS)
        const gy = dI[2 * c + 1] = descale(deriv[q + 1] * w00 + deriv[q + 3] * w01 + deriv[r + 1] * w10 + deriv[r + 3] * w11, W_BITS)
        a11 += gx * gx; a12 += gx * gy; a22 += gy * gy
      }
      const A11 = f32(a11 * FLT_SCALE), A12 = f32(a12 * FLT_SCALE), A22 = f32(a22 * FLT_SCALE)
      let D = f32(f32(A11 * A22) - f32(A12 * A12))
      const root = f32(Math.sqrt(f32(f32(f32(A11 - A22) * f32(A11 - A22)) + f32(f32(4 * A12) * A12))))
      if (f32(f32(f32(A22 + A11) - root) / (2 * WIN * WIN)) < MIN_EIG || D < 1.1920929e-7) {if (!level) status[k] = 0; continue}
      D = f32(1 / D); nx = f32(nx - half); ny = f32(ny - half)
      let pdx = 0, pdy = 0
      for (let j = 0; j < ITERS; j++) {
        const jx = Math.floor(nx), jy = Math.floor(ny)
        if (jx < -WIN || jx >= w || jy < -WIN || jy >= h) {if (!level) status[k] = 0; break}
        ;[w00, w01, w10, w11] = weights(f32(nx - jx), f32(ny - jy))
        let b1 = 0, b2 = 0
        for (let y = 0; y < WIN; y++) for (let x = 0; x < WIN; x++) {
          const o = (jy + y + WIN) * pw + jx + x + WIN, c = y * WIN + x
          const diff = descale(J[o] * w00 + J[o + 1] * w01 + J[o + pw] * w10 + J[o + pw + 1] * w11, W_BITS - 5) - I[c]
          b1 += diff * dI[2 * c]; b2 += diff * dI[2 * c + 1]
        }
        const B1 = f32(b1 * FLT_SCALE), B2 = f32(b2 * FLT_SCALE)
        const dx = f32(f32(f32(A12 * B2) - f32(A22 * B1)) * D), dy = f32(f32(f32(A12 * B1) - f32(A11 * B2)) * D)
        nx = f32(nx + dx); ny = f32(ny + dy)
        out[2 * k] = f32(nx + half); out[2 * k + 1] = f32(ny + half)
        if (dx * dx + dy * dy <= EPS) break
        if (j > 0 && Math.abs(f32(dx + pdx)) < 0.01 && Math.abs(f32(dy + pdy)) < 0.01) {
          out[2 * k] = f32(out[2 * k] - f32(dx * 0.5)); out[2 * k + 1] = f32(out[2 * k + 1] - f32(dy * 0.5))
          break
        }
        pdx = dx; pdy = dy
      }
    }
  }
}

export const pair = (a, b, mask = null, max = CORNERS) => {
  const {raw, w, h} = a[0], p = corners(raw, w, h, mask, max), n = p.length / 2
  const q = new Float32Array(2 * n), back = new Float32Array(2 * n), ok = new Uint8Array(n), ok2 = new Uint8Array(n), out = []
  lk(a, b, p, q, ok)
  lk(b, a, q, back, ok2)
  for (let k = 0; k < n; k++) {
    if (ok[k] && ok2[k] && f32(Math.hypot(back[2 * k] - p[2 * k], back[2 * k + 1] - p[2 * k + 1])) < BACK) out.push(p[2 * k], p[2 * k + 1], q[2 * k], q[2 * k + 1])
  }
  return Float32Array.from(out)
}
