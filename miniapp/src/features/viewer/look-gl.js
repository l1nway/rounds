import {LOOK} from '../../constants/look.js'
import {APPLY, BOX, COEF, HEAD, POOL, REDUCE, VERTEX} from './look-glsl.js'

const BLOCK = 8
const ZERO = new Float32Array(4)
const OPTIONS = {alpha: false, depth: false, stencil: false, antialias: false}

// [DOC: look-shaders]
const even = v => {const r = Math.round(v); return r - v === 0.5 && r % 2 ? r - 1 : r}
const gridOf = (w, h) => [w, h].map(n => Math.max(1, even(n * (LOOK.GRID / Math.max(w, h)))))
const levelsOf = (w, h) => {
  const sizes = []
  do {w = Math.ceil(w / BLOCK); h = Math.ceil(h / BLOCK); sizes.push([w, h])} while (w > 1 || h > 1)
  return sizes
}

// [DOC: look-gl]
export function createLook(canvas) {
  const gl = canvas.getContext('webgl2', OPTIONS)
  const format = gl && (gl.getExtension('EXT_color_buffer_float') ? gl.RGBA32F : gl.getExtension('EXT_color_buffer_half_float') && gl.RGBA16F)
  if (!format || gl.isContextLost()) return null
  const T = gl.TEXTURE_2D
  const owned = []

  const program = source => {
    const p = gl.createProgram()
    for (const [type, text] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, HEAD + source]]) {
      const shader = gl.createShader(type)
      gl.shaderSource(shader, text)
      gl.compileShader(shader)
      gl.attachShader(p, shader)
    }
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getAttachedShaders(p).map(s => gl.getShaderInfoLog(s)).join('') || gl.getProgramInfoLog(p))
    const at = {}
    return {p, at: name => at[name] ??= gl.getUniformLocation(p, name)}
  }

  const texture = (w, h) => {
    const tex = gl.createTexture()
    gl.bindTexture(T, tex)
    if (w) {gl.texStorage2D(T, 1, format, w, h); owned.push(tex)}
    const filter = w ? gl.NEAREST : gl.LINEAR
    for (const [key, value] of [[gl.TEXTURE_MIN_FILTER, filter], [gl.TEXTURE_MAG_FILTER, filter], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(T, key, value)
    return tex
  }

  const target = (w, h, ...textures) => {
    const fb = gl.createFramebuffer()
    owned.push(fb)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    textures.forEach((tex, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, T, tex, 0))
    gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i))
    textures.forEach((_, i) => gl.clearBufferfv(gl.COLOR, i, ZERO))  // [DOC: look-gl]
    return {fb, w, h, tex: textures[0]}
  }
  const layer = ([w, h]) => target(w, h, texture(w, h))

  const run = {pool: program(POOL), box: program(BOX), coef: program(COEF), reduce: program(REDUCE), apply: program(APPLY)}
  const frame = texture()
  let maps = null
  let k = 0

  const build = (w, h) => {
    owned.splice(0).forEach(item => item instanceof WebGLTexture ? gl.deleteTexture(item) : gl.deleteFramebuffer(item))
    canvas.width = w
    canvas.height = h
    const grid = gridOf(w, h)
    const t0 = texture(...grid), t1 = texture(...grid)
    const levels = levelsOf(...grid).map(layer)
    maps = {w, h, grid, t0, t1, pool: target(...grid, t0, t1), scratch: layer(grid), mean: layer(grid), sums: layer(grid), levels: levels.slice(0, -1), ema: [levels.at(-1), layer([1, 1])], fresh: true}
  }

  const pass = ({p, at}, out, inputs, uniforms = {}) => {
    gl.useProgram(p)
    gl.bindFramebuffer(gl.FRAMEBUFFER, out?.fb ?? null)
    gl.viewport(0, 0, out?.w ?? canvas.width, out?.h ?? canvas.height)
    Object.entries(inputs).forEach(([name, tex], i) => {gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(T, tex); gl.uniform1i(at(name), i)})
    for (const [name, [type, ...values]] of Object.entries(uniforms)) gl[`uniform${type}`](at(name), ...values)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  const box = (src, out, radius) => {
    pass(run.box, maps.scratch, {src}, {dir: ['2i', 1, 0], radius: ['1i', radius]})
    pass(run.box, out, {src: maps.scratch.tex}, {dir: ['2i', 0, 1], radius: ['1i', radius]})
  }

  return (video, {t, ev, hdr, alpha}) => {
    const {videoWidth: w, videoHeight: h} = video
    if (!w || !h || video.readyState < 2) return false
    if (w !== maps?.w || h !== maps?.h) build(w, h)
    const m = maps
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(T, frame)
    gl.texImage2D(T, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video)
    pass(run.pool, m.pool, {src: frame}, {hdr: ['1i', hdr], grid: ['2i', ...m.grid]})
    box(m.t0, m.mean, LOOK.RADIUS)
    box(m.t1, m.sums, LOOK.SPREAD)
    const top = m.ema[k], prev = m.ema[k ^ 1].tex
    let src = m.mean.tex
    for (const out of [...m.levels, top]) {
      pass(run.reduce, out, {src, prev}, {alpha: ['1f', out === top && !m.fresh ? alpha : 1]})
      src = out.tex
    }
    pass(run.coef, m.pool, {mean: m.mean.tex, sums: m.sums.tex})
    box(m.t0, m.mean, LOOK.RADIUS)
    pass(run.apply, null, {src: frame, coef: m.mean.tex, ratio: m.t1, top: top.tex}, {hdr: ['1i', hdr], t: ['1f', t], ev: ['1f', ev]})
    k ^= 1
    m.fresh = false
    return true
  }
}
