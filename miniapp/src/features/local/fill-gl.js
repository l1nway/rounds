// [DOC: local-fill]
const COMMON = `
const float COVER = 0.999;
uniform sampler2D params;
uniform vec2 frame;
uniform int disc;
uniform float size, rim, safe;
vec4 win(int k) {return texelFetch(params, ivec2(k, 0), 0);}
bool good(int k, ivec2 q) {
  if (q.x < 0 || q.y < 0 || q.x >= int(size) || q.y >= int(size)) return false;
  vec4 w = win(k);
  vec3 r0 = texelFetch(params, ivec2(k, 1), 0).xyz, r1 = texelFetch(params, ivec2(k, 2), 0).xyz;
  vec2 pt = ((vec2(q) + 0.5) / size - 0.5) * w.z + w.xy;
  vec2 p = vec2(dot(r0.xy, pt) + r0.z, dot(r1.xy, pt) + r1.z);
  if (disc == 1) return length(p - frame * 0.5) <= safe * min(frame.x, frame.y) * 0.5;
  return !(p.x < rim || p.x > frame.x - rim || p.y < rim || p.y > frame.y - rim);
}
float validAt(int k, vec2 pd) {
  vec2 f = floor(pd), t = pd - f;
  ivec2 q = ivec2(f);
  return (good(k, q) ? (1.0 - t.x) * (1.0 - t.y) : 0.0) + (good(k, q + ivec2(1, 0)) ? t.x * (1.0 - t.y) : 0.0)
    + (good(k, q + ivec2(0, 1)) ? (1.0 - t.x) * t.y : 0.0) + (good(k, q + ivec2(1, 1)) ? t.x * t.y : 0.0);
}
`

const RING = `
uniform highp sampler2DArray ring;
vec4 ringAt(int slot, ivec2 q) {return q.x < 0 || q.y < 0 || q.x >= int(size) || q.y >= int(size) ? vec4(0) : texelFetch(ring, ivec3(q, slot), 0);}
vec4 bilerp(int slot, vec2 pd) {
  vec2 f = floor(pd), t = pd - f;
  ivec2 q = ivec2(f);
  return ringAt(slot, q) * (1.0 - t.x) * (1.0 - t.y) + ringAt(slot, q + ivec2(1, 0)) * t.x * (1.0 - t.y)
    + ringAt(slot, q + ivec2(0, 1)) * (1.0 - t.x) * t.y + ringAt(slot, q + ivec2(1, 1)) * t.x * t.y;
}
`

const MASK = `${COMMON}
uniform int k;
void main() {color = vec4(good(k, ivec2(gl_FragCoord.xy)) ? 1.0 : 0.0, 0, 0, 1);}`

const BOX = `
uniform sampler2D src, mask;
uniform int axis, radius, last;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy), n = textureSize(src, 0);
  float sum = 0.0, count = 0.0;
  for (int d = -radius; d <= radius; d++) {
    ivec2 p = q + (axis == 0 ? ivec2(d, 0) : ivec2(0, d));
    if (p.x < 0 || p.y < 0 || p.x >= n.x || p.y >= n.y) continue;
    sum += texelFetch(src, p, 0).r;
    count += 1.0;
  }
  color = vec4(sum / count * (last == 1 ? texelFetch(mask, q, 0).r : 1.0), 0, 0, 1);
}`

const FILL = `${COMMON}${RING}
uniform sampler2D donors, keep, canvas;
uniform int k, self, count, paint;
uniform vec3 cinfo;
uniform vec2 csize;
layout(location = 1) out vec4 extra;
vec4 canvasAt(ivec2 q, ivec2 n) {return q.x < 0 || q.y < 0 || q.x >= n.x || q.y >= n.y ? vec4(0) : texelFetch(canvas, q, 0);}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec3 img = texelFetch(ring, ivec3(q, self), 0).rgb, acc = vec3(0);
  float a = texelFetch(keep, q, 0).r, cover = 0.0;
  vec4 w = win(k);
  vec2 v = (vec2(q) + 0.5) / size - 0.5;
  if (a < 1.0) {
    for (int d = 0; d < count && cover < 1.0; d++) {
      vec4 e = texelFetch(donors, ivec2(d, 0), 0), wj = win(int(e.x));
      vec2 pd = ((2.0 * (v * w.z + (w.xy - wj.xy)) / wj.z + 1.0) * size - 1.0) * 0.5;
      if (validAt(int(e.x), pd) >= COVER) {acc = bilerp(int(e.y), pd).rgb; cover = 1.0;}
    }
    if (paint == 1 && cover < 1.0) {
      ivec2 n = ivec2(csize);
      vec2 g = (v * w.z + w.xy - cinfo.xy) * cinfo.z / csize * 2.0 - 1.0, pc = ((g + 1.0) * csize - 1.0) * 0.5, f = floor(pc), t = pc - f;
      ivec2 c = ivec2(f);
      vec4 s = canvasAt(c, n) * (1.0 - t.x) * (1.0 - t.y) + canvasAt(c + ivec2(1, 0), n) * t.x * (1.0 - t.y)
        + canvasAt(c + ivec2(0, 1), n) * (1.0 - t.x) * t.y + canvasAt(c + ivec2(1, 1), n) * t.x * t.y;
      if (s.a >= COVER) {acc = s.rgb; cover = 1.0;}
    }
  }
  color = vec4(img * a + acc * (1.0 - a), min(a + cover * (1.0 - a), 1.0));
  extra = vec4(acc, cover);
}`

const POOL = `
uniform sampler2D src;
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy) * 2, n = textureSize(src, 0);
  vec4 sum = vec4(0);
  float count = 0.0;
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) if (q.x + i < n.x && q.y + j < n.y) {sum += texelFetch(src, q + ivec2(i, j), 0); count += 1.0;}
  color = sum / count;
}`

const BASE = `
uniform sampler2D src;
void main() {
  ivec2 n = textureSize(src, 0);
  vec4 sum = vec4(0);
  for (int y = 0; y < n.y; y++) for (int x = 0; x < n.x; x++) sum += texelFetch(src, ivec2(x, y), 0);
  color = vec4(sum.rgb / max(sum.a, 1e-6), 1);
}`

const UP = `
uniform sampler2D src, coarse, keep, extra;
uniform int last;
uniform highp sampler2DArray ring;
uniform int self;
vec3 resize(ivec2 q, ivec2 to) {
  ivec2 from = textureSize(coarse, 0);
  vec2 s = max((vec2(q) + 0.5) * vec2(from) / vec2(to) - 0.5, 0.0), f = floor(s), t = s - f;
  ivec2 a = ivec2(f), b = min(a + 1, from - 1);
  vec3 top = texelFetch(coarse, ivec2(a.x, a.y), 0).rgb * (1.0 - t.x) + texelFetch(coarse, ivec2(b.x, a.y), 0).rgb * t.x;
  vec3 bottom = texelFetch(coarse, ivec2(a.x, b.y), 0).rgb * (1.0 - t.x) + texelFetch(coarse, ivec2(b.x, b.y), 0).rgb * t.x;
  return top * (1.0 - t.y) + bottom * t.y;
}
void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  vec4 x = texelFetch(src, q, 0);
  vec3 rest = x.rgb + (1.0 - x.a) * resize(q, textureSize(src, 0));
  if (last == 0) {color = vec4(rest, 1); return;}
  float a = texelFetch(keep, q, 0).r;
  vec4 e = texelFetch(extra, q, 0);
  color = vec4(a * texelFetch(ring, ivec3(q, self), 0).rgb + (1.0 - a) * (e.rgb + (1.0 - e.a) * rest), 1);
}`

const COPY = `
uniform sampler2D src;
void main() {color = vec4(texelFetch(src, ivec2(gl_FragCoord.xy), 0).rgb, 1);}`

const LAYER = `
uniform highp sampler2DArray ring;
uniform int self;
void main() {color = vec4(texelFetch(ring, ivec3(ivec2(gl_FragCoord.xy), self), 0).rgb, 1);}`

const WRITE = `${COMMON}${RING}
uniform int k, self;
uniform vec3 cinfo, cwin;
void main() {
  vec2 g = (floor(gl_FragCoord.xy) + 0.5) / cinfo.z + cinfo.xy - cwin.xy;
  vec2 pd = ((2.0 * g / cwin.z + 1.0) * size - 1.0) * 0.5;
  if (validAt(k, pd) < COVER) discard;
  color = vec4(bilerp(self, pd).rgb, 1);
}`

export const SHADERS = {MASK, BOX, FILL, POOL, BASE, UP, COPY, LAYER, WRITE}
