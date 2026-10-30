import {glOf} from './gl.js'

// [DOC: local-warp]
const TAPS = 3
const OVER = 2
const GUARD = 4
const sinc = x => x ? Math.sin(Math.PI * x) / (Math.PI * x) : 1
const lanczos = x => Math.abs(x) < TAPS ? sinc(x) * sinc(x / TAPS) : 0

export const weights = (c, side, n, size) => {
  const s = side / size, sc = Math.max(s, 1), taps = Math.ceil(2 * TAPS * sc) + 1, data = new Float32Array((taps + 1) * size)
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < size; i++) {
    const u = c - side / 2 - 0.5 + (i + 0.5) * s, first = Math.floor(u - TAPS * sc) + 1, row = []
    for (let k = 0; k < taps; k++) row.push(lanczos((first + k - u) / sc))
    const sum = row.reduce((a, b) => a + b, 0)
    data[i * (taps + 1)] = first
    row.forEach((v, k) => {data[i * (taps + 1) + k + 1] = v / sum})
    lo = Math.min(lo, Math.max(0, Math.min(n - 1, first)))
    hi = Math.max(hi, Math.max(0, Math.min(n - 1, first + taps - 1)) + 1)
  }
  return {lo, hi, taps, size, data}
}

const LANCZOS = `
uniform sampler2D src, taps;
uniform int count, n, axis, base, shift, gamma, floor0, clip;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int i = axis == 0 ? p.x : p.y;
  int first = int(texelFetch(taps, ivec2(0, i), 0).r);
  vec4 acc = vec4(0);
  for (int k = 0; k < count; k++) {
    int j = clamp(first + k, 0, n - 1) - base;
    vec4 v = texelFetch(src, axis == 0 ? ivec2(j, p.y + shift) : ivec2(p.x + shift, j), 0);
    if (gamma == 1) v = pow(max(v, 0.0), vec4(2.4));
    if (floor0 == 1) v = max(v, 0.0);
    acc += texelFetch(taps, ivec2(k + 1, i), 0).r * v;
  }
  color = vec4(clip == 1 ? clamp(acc.rgb, 0.0, 1.0) : clip == 2 ? max(acc.rgb, 0.0) : acc.rgb, 1);
}`

const ROTATE = `
uniform sampler2D src;
uniform float c, s, big;
uniform int m;
float c1(float x) {return ((1.25 * x - 2.25) * x) * x + 1.0;}
float c2(float x) {return ((-0.75 * x + 3.75) * x - 6.0) * x + 3.0;}
vec4 tap(int x, int y) {return texelFetch(src, ivec2(clamp(x, 0, m - 1), clamp(y, 0, m - 1)), 0);}
vec4 line(int x, int y, vec4 w) {return tap(x - 1, y) * w.x + tap(x, y) * w.y + tap(x + 1, y) * w.z + tap(x + 2, y) * w.w;}
vec4 coef(float t) {return vec4(c2(t + 1.0), c1(t), c1(1.0 - t), c2(2.0 - t));}
void main() {
  vec2 g = floor(gl_FragCoord.xy) + 0.5 - big * 0.5;
  float scale = 2.0 / float(m);
  vec2 grid = vec2(c * g.x - s * g.y, s * g.x + c * g.y) * scale;
  vec2 at = ((grid + 1.0) * float(m) - 1.0) * 0.5, f = floor(at), t = at - f;
  ivec2 q = ivec2(f);
  vec4 wx = coef(t.x), wy = coef(t.y);
  color = vec4((line(q.x, q.y - 1, wx) * wy.x + line(q.x, q.y, wx) * wy.y + line(q.x, q.y + 1, wx) * wy.z + line(q.x, q.y + 2, wx) * wy.w).rgb, 1);
}`

const PRESENT = `
uniform sampler2D src;
uniform int size;
void main() {color = vec4(pow(clamp(texelFetch(src, ivec2(gl_FragCoord.x, float(size) - gl_FragCoord.y), 0).rgb, 0.0, 1.0), vec3(1.0 / 2.4)), 1);}`

const LOAD = `
uniform sampler2D src;
void main() {color = vec4(pow(texelFetch(src, ivec2(gl_FragCoord.xy), 0).rgb, vec3(2.4)), 1);}`

// [DOC: local-warp]
export const createWarp = (canvas, {size = 640, half = true} = {}) => {
  const g = glOf(canvas, half)
  if (!g) return null
  const {gl} = g, run = {lanczos: g.program(LANCZOS), rotate: g.program(ROTATE), present: g.program(PRESENT), load: g.program(LOAD)}, big = OVER * size, at = {}
  const present = tex => g.pass(run.present, null, [size, size], {src: tex}, {size: ['1i', size]})
  const load = image => {
    at.tone = g.grow(at.tone, size, size, gl.RGBA8)
    g.upload(at.tone, image, size, size)
    at.lin = g.grow(at.lin, size, size)
    g.pass(run.load, at.lin, [size, size], {src: at.tone})
    return at.lin
  }
  const tapsOf = (key, w) => {
    at[key] = g.grow(at[key], w.taps + 1, w.size, gl.R32F)
    g.upload(at[key], {data: w.data}, w.taps + 1, w.size)
    return at[key]
  }
  const separable = (src, wx, wy, n, out, [w, h], gamma, clip) => {
    at.mid = g.grow(at.mid, wx.hi - wx.lo, h)
    g.pass(run.lanczos, at.mid, [wx.hi - wx.lo, h], {src, taps: tapsOf('ty', wy)}, {count: ['1i', wy.taps], n: ['1i', n[1]], axis: ['1i', 1], base: ['1i', 0], shift: ['1i', wx.lo], gamma: ['1i', gamma], floor0: ['1i', clip === 2 ? 1 : 0], clip: ['1i', 0]})
    g.pass(run.lanczos, out, [w, h], {src: at.mid, taps: tapsOf('tx', wx)}, {count: ['1i', wx.taps], n: ['1i', n[0]], axis: ['1i', 0], base: ['1i', wx.lo], shift: ['1i', 0], gamma: ['1i', 0], floor0: ['1i', 0], clip: ['1i', clip]})
  }
  const source = (image, w, h, linear) => {
    at.src = g.grow(at.src, w, h, linear ? gl.RGBA32F : gl.RGBA8)
    g.upload(at.src, image, w, h)
    return at.src
  }
  const warp = (image, w, h, [cx, cy, side, angle = 0], linear = false) => {
    const src = source(image, w, h, linear)
    at.out = g.grow(at.out, size, size)
    if (!angle) {
      separable(src, weights(cx, side, w, size), weights(cy, side, h, size), [w, h], at.out, [size, size], linear ? 0 : 1, 1)
      return at.out
    }
    const c = Math.cos(angle), s = Math.sin(angle), m = Math.ceil(big * (Math.abs(c) + Math.abs(s))) + 2 * GUARD, box = m * side / big
    at.box = g.grow(at.box, m, m)
    separable(src, weights(cx, box, w, m), weights(cy, box, h, m), [w, h], at.box, [m, m], linear ? 0 : 1, 1)
    at.big = g.grow(at.big, big, big)
    g.pass(run.rotate, at.big, [big, big], {src: at.box}, {c: ['1f', c], s: ['1f', s], big: ['1f', big], m: ['1i', m]})
    const down = weights(big / 2, big, big, size)
    separable(at.big, down, down, [big, big], at.out, [size, size], 0, 2)
    return at.out
  }
  return {g, warp, present, load, size}
}
