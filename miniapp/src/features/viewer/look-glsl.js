import {LOOK} from '../../constants/look.js'

const {MOBIUS: J, PROXY_PEAK: PEAK, PQ: [M1, M2, C1, C2, C3]} = LOOK
// [DOC: look-shaders]
const MA = -J * J * (PEAK - 1) / (J * J - 2 * J + PEAK)
const MB = (J * J - 2 * J * PEAK + PEAK) / (PEAK - 1)
const pq = nits => ((C1 + C2 * (nits / 10000) ** M1) / (1 + C3 * (nits / 10000) ** M1)) ** M2
const PQ_PEAK = pq(LOOK.HDR_PEAK)
const PQ_TOP = pq(LOOK.SDR_WHITE) / PQ_PEAK
const DEFS = {
  FLOOR: LOOK.FLOOR, EPS: LOOK.EPS, CLIP0: LOOK.CLIP[0], CLIP1: LOOK.CLIP[1], PIVOT: LOOK.PIVOT, LIFT: LOOK.LIFT,
  DARK0: LOOK.DARK[0], DARK1: LOOK.DARK[1], SHADE0: LOOK.SHADE[0], SHADE1: LOOK.SHADE[1], EV_LIFT: LOOK.EV_LIFT, KNEE: LOOK.KNEE, WHITE: LOOK.WHITE, TARGET: LOOK.TARGET, SOFT: LOOK.SOFT,
  DETAIL: LOOK.DETAIL, SHOULDER: LOOK.SHOULDER, GAMMA: LOOK.GAMMA, SDR_WHITE: LOOK.SDR_WHITE,
  J, MA, MB, MK: (MB + J) ** 2 / (MB - MA), M1, M2, C1, C2, C3, PQ_PEAK, PQ_TOP, KS: 1.5 * PQ_TOP - 0.5
}
const float = n => Number.isInteger(n) ? `${n}.0` : String(n)

export const VERTEX = `#version 300 es
void main() {gl_Position = vec4(vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4.0 - 1.0, 0, 1);}`

export const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${Object.entries(DEFS).map(([key, value]) => `#define ${key} (${float(value)})`).join('\n')}
uniform int hdr;
float lum(vec3 x) {return max(dot(x, vec3(0.2126, 0.7152, 0.0722)), 0.0);}
float peak3(vec3 x) {return max(max(x.r, x.g), x.b);}
vec3 linear(vec3 v) {
  if (hdr == 0) return pow(v, vec3(GAMMA));
  vec3 l = mix(v / 4.5, pow((v + 0.099) / 1.099, vec3(1.0 / 0.45)), step(0.081, v));
  float y = max(peak3(l), 1e-6), s = y <= J ? y : (y * MB - MK * MA) / (MK - min(y, MK - 1e-4));
  return l * s / y * (100.0 / SDR_WHITE);
}
`

export const POOL = `
uniform sampler2D src;
uniform ivec2 grid;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 size = textureSize(src, 0), p = ivec2(gl_FragCoord.xy), a = p * size / grid, b = ((p + 1) * size + grid - 1) / grid;
  vec3 s = vec3(0);
  for (int j = a.y; j < b.y; j++) for (int i = a.x; i < b.x; i++) s += texelFetch(src, ivec2(i, j), 0).rgb;
  vec3 x = linear(s / float((b.x - a.x) * (b.y - a.y)));
  float l = lum(x), g = log2(l + FLOOR);
  float keep = hdr == 0 ? 1.0 - smoothstep(CLIP0, CLIP1, pow(clamp(peak3(x), 0.0, 1.0), 1.0 / GAMMA)) : 1.0;
  o0 = vec4(g, g * g, 0, 0);
  o1 = vec4(x, l) * keep;
}`

export const BOX = `
uniform sampler2D src;
uniform ivec2 dir;
uniform int radius;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), n = textureSize(src, 0) - 1;
  vec4 s = vec4(0);
  for (int i = -radius; i <= radius; i++) s += texelFetch(src, clamp(p + dir * i, ivec2(0), n), 0);
  o = s / float(2 * radius + 1);
}`

export const COEF = `
uniform sampler2D mean, sums;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 m = texelFetch(mean, p, 0).xy;
  vec4 s = texelFetch(sums, p, 0);
  float v = max(m.y - m.x * m.x, 0.0), a = v / (v + EPS);
  o0 = vec4(a, m.x - a * m.x, 0, 0);
  o1 = vec4(s.rgb / max(s.a, 1e-6), 0);
}`

export const REDUCE = `
uniform sampler2D src, prev;
uniform float alpha;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 8, n = textureSize(src, 0);
  float m = -1e30;
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
    ivec2 q = p + ivec2(i, j);
    if (q.x < n.x && q.y < n.y) m = max(m, texelFetch(src, q, 0).x);
  }
  o = vec4(alpha >= 1.0 ? m : mix(texelFetch(prev, ivec2(0), 0).x, m, alpha));
}`

export const APPLY = `
uniform sampler2D src, coef, ratio, top;
uniform float t, ev;
out vec4 o;
vec4 bilerp(sampler2D s, vec2 uv) {
  ivec2 n = textureSize(s, 0) - 1;
  vec2 g = clamp(uv * vec2(n + 1) - 0.5, vec2(0), vec2(n)), f = fract(g);
  ivec2 i = ivec2(g), j = min(i + 1, n);
  return mix(mix(texelFetch(s, i, 0), texelFetch(s, ivec2(j.x, i.y), 0), f.x), mix(texelFetch(s, ivec2(i.x, j.y), 0), texelFetch(s, j, 0), f.x), f.y);
}
vec3 rebuild(vec3 x, vec3 r) {
  vec3 m = smoothstep(CLIP0, CLIP1, pow(clamp(x, 0.0, 1.0), vec3(1.0 / GAMMA))), keep = 1.0 - m;
  r = max(r, 1e-3);
  float est = dot(keep, x) / max(dot(keep, r), 1e-3);
  return x + m * max(r * est - x, 0.0) * (t * smoothstep(0.0, 0.5, keep.r + keep.g + keep.b));
}
float curve(float base, float hi) {
  float b = base + ev * (ev < 0.0 ? smoothstep(SHADE0, SHADE1, base) : 1.0);
  b += max(t, EV_LIFT * max(ev, 0.0)) * LIFT * max(PIVOT - b, 0.0) * smoothstep(DARK0, DARK1, b);
  float peak = hi + ev, cap = min(peak, max(hi, WHITE));
  cap += t * (min(cap, TARGET) - cap);
  if (peak <= cap || peak <= KNEE) return b;
  float d = b - KNEE;
  return b - (1.0 - (cap - KNEE) / (peak - KNEE)) * 0.5 * (d + sqrt(d * d + SOFT * SOFT));
}
float pqInv(float n) {float y = pow(n / 10000.0, M1); return pow((C1 + C2 * y) / (1.0 + C3 * y), M2);}
float pqEotf(float e) {float p = pow(e, 1.0 / M2); return pow(max(p - C1, 0.0) / (C2 - C3 * p), 1.0 / M1) * 10000.0;}
float eetf(float n) {
  float e = min(pqInv(n) / PQ_PEAK, 1.0), s = max((e - KS) / (1.0 - KS), 0.0), s2 = s * s, s3 = s2 * s;
  float p = (2.0 * s3 - 3.0 * s2 + 1.0) * KS + (s3 - 2.0 * s2 + s) * (1.0 - KS) + (3.0 * s2 - 2.0 * s3) * PQ_TOP;
  return pqEotf((e < KS ? e : p) * PQ_PEAK);
}
vec3 display(vec3 x) {
  if (hdr != 0) {
    vec3 n = max(x, 0.0) * SDR_WHITE;
    float m = max(peak3(n), 1e-6);
    return clamp(n * eetf(m) / m / SDR_WHITE, 0.0, 1.0);
  }
  float m = peak3(x), f = m > SHOULDER ? SHOULDER + (1.0 - SHOULDER) * (1.0 - exp((SHOULDER - m) / (1.0 - SHOULDER))) : m;
  return clamp(x * f / max(m, 1e-6), 0.0, 1.0);
}
void main() {
  ivec2 size = textureSize(src, 0), p = ivec2(int(gl_FragCoord.x), int(float(size.y) - gl_FragCoord.y));
  vec2 uv = (vec2(p) + 0.5) / vec2(size);
  vec3 x = linear(texelFetch(src, p, 0).rgb);
  if (hdr == 0 && t > 0.0) x = rebuild(x, bilerp(ratio, uv).rgb);
  vec2 ab = bilerp(coef, uv).xy;
  float g = log2(lum(x) + FLOOR), base = ab.x * g + ab.y;
  x *= exp2(curve(base, texelFetch(top, ivec2(0), 0).x) + (g - base) * (1.0 + t * DETAIL) - g);
  o = vec4(pow(display(x), vec3(1.0 / GAMMA)), 1);
}`
