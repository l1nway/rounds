const KEEP_BLOB = 0.2
const MIN_AREA = 1e-4

// [DOC: local-welzl]
const circle2 = (a, b) => ({cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, r: Math.hypot(a[0] - b[0], a[1] - b[1]) / 2})
const circle3 = (a, b, c) => {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
  if (Math.abs(d) < 1e-9) return circle2(a, b)
  const [as, bs, cs] = [a, b, c].map(p => p[0] ** 2 + p[1] ** 2)
  const cx = (as * (b[1] - c[1]) + bs * (c[1] - a[1]) + cs * (a[1] - b[1])) / d
  const cy = (as * (c[0] - b[0]) + bs * (a[0] - c[0]) + cs * (b[0] - a[0])) / d
  return {cx, cy, r: Math.hypot(cx - a[0], cy - a[1])}
}
const inCircle = (p, c) => c && Math.hypot(p[0] - c.cx, p[1] - c.cy) <= c.r + 1e-6

export const minEnclosingCircle = pts => {
  const p = pts.slice()
  for (let i = p.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0, t = p[i]
    p[i] = p[j]
    p[j] = t
  }
  const welzl = (n, b) => {
    if (!n || b.length === 3) return !b.length ? {cx: 0, cy: 0, r: 0} : b.length === 1 ? {cx: b[0][0], cy: b[0][1], r: 0} : b.length === 2 ? circle2(b[0], b[1]) : circle3(b[0], b[1], b[2])
    const pt = p[n - 1], c = welzl(n - 1, b)
    return inCircle(pt, c) ? c : welzl(n - 1, [...b, pt])
  }
  return welzl(p.length, [])
}

export const measure = (logits, score, w, h) => {
  const n = w * h, bin = new Uint8Array(n), labels = new Int32Array(n), q = new Int32Array(n), areas = [0]
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, Math.min(255, (y + 0.5) * 256 / h - 0.5)), y0 = sy | 0, y1 = Math.min(255, y0 + 1), wy = sy - y0
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, Math.min(255, (x + 0.5) * 256 / w - 0.5)), x0 = sx | 0, x1 = Math.min(255, x0 + 1), wx = sx - x0
      const v = (logits[y0 * 256 + x0] * (1 - wx) + logits[y0 * 256 + x1] * wx) * (1 - wy) + (logits[y1 * 256 + x0] * (1 - wx) + logits[y1 * 256 + x1] * wx) * wy
      if (v > 0) bin[y * w + x] = 1
    }
  }
  let maxArea = 0
  for (let i = 0; i < n; i++) {
    if (!bin[i] || labels[i]) continue
    const id = areas.length
    labels[i] = id
    let head = 0, tail = 0
    q[tail++] = i
    while (head < tail) {
      const cur = q[head++], cy = (cur / w) | 0, cx = cur - cy * w
      const y0 = Math.max(0, cy - 1), y1 = Math.min(h - 1, cy + 1), x0 = Math.max(0, cx - 1), x1 = Math.min(w - 1, cx + 1)
      for (let ny = y0; ny <= y1; ny++) for (let nx = x0; nx <= x1; nx++) {
        const nb = ny * w + nx
        if (bin[nb] && !labels[nb]) {labels[nb] = id; q[tail++] = nb}
      }
    }
    areas.push(tail)
    if (tail > maxArea) maxArea = tail
  }
  const minKeep = KEEP_BLOB * maxArea, pts = []
  let sum = 0, x0 = w, y0 = h, x1 = 0, y1 = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, id = labels[i]
    if (id && areas[id] >= minKeep) {
      sum++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (!x || !y || x === w - 1 || y === h - 1 || !bin[i - 1] || !bin[i + 1] || !bin[i - w] || !bin[i + w]) pts.push([x, y])
    }
  }
  const present = score > 0 && sum >= MIN_AREA * w * h
  if (!present || !pts.length) return {present: false, cx: NaN, cy: NaN, r: NaN, area: sum, box: null}
  const c = minEnclosingCircle(pts)
  return {present: true, cx: c.cx + 0.5, cy: c.cy + 0.5, r: c.r + 0.5, area: sum, box: [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h]}
}

export const histogram = (rgba, w, h) => {
  const counts = new Float32Array(512)
  let tot = 0
  for (let y = 0; y < h; y += 4) {
    const row = y * w * 4
    for (let x = 0; x < w; x += 4) {
      counts[((rgba[row + x * 4] >> 5) << 6) | ((rgba[row + x * 4 + 1] >> 5) << 3) | (rgba[row + x * 4 + 2] >> 5)]++
      tot++
    }
  }
  for (let i = 0; i < 512; i++) counts[i] /= tot
  return counts
}

