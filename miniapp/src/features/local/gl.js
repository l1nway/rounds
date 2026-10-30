const VERTEX = `#version 300 es
void main() {gl_Position = vec4(vec2(gl_VertexID & 1, gl_VertexID >> 1) * 4.0 - 1.0, 0, 1);}`
export const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;
layout(location = 0) out vec4 color;
`
const OPTIONS = {alpha: false, depth: false, stencil: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true}

// [DOC: local-gl]
export const glOf = (canvas, half = true) => {
  const gl = canvas.getContext('webgl2', OPTIONS)
  const full = gl?.getExtension('EXT_color_buffer_float'), halfOk = full || gl?.getExtension('EXT_color_buffer_half_float')
  if (!gl || !(half ? halfOk : full) || gl.isContextLost()) return null
  const T = gl.TEXTURE_2D, format = half ? gl.RGBA16F : gl.RGBA32F
  const SIZES = {[gl.RGBA16F]: 8, [gl.RGBA32F]: 16, [gl.R32F]: 4, [gl.RGBA8]: 4}
  let bytes = 0

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

  const texture = (w, h, kind = format, layers = 0) => {
    const tex = gl.createTexture(), target = layers ? gl.TEXTURE_2D_ARRAY : T
    gl.bindTexture(target, tex)
    if (layers) gl.texStorage3D(target, 1, kind, w, h, layers)
    else gl.texStorage2D(T, 1, kind, w, h)
    for (const key of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(target, key, gl.NEAREST)
    for (const key of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(target, key, gl.CLAMP_TO_EDGE)
    bytes += w * h * SIZES[kind] * (layers || 1)
    return {tex, w, h, kind, layers, target, fbs: {}}
  }

  const free = t => {
    if (!t) return
    gl.deleteTexture(t.tex)
    Object.values(t.fbs).forEach(fb => gl.deleteFramebuffer(fb))
    bytes -= t.w * t.h * SIZES[t.kind] * (t.layers || 1)
  }

  const grow = (t, w, h, kind = format) => t && t.w >= w && t.h >= h && t.kind === kind ? t : (free(t), texture(Math.max(w, t?.w ?? 0), Math.max(h, t?.h ?? 0), kind))

  const attach = (t, i, layer) => layer === undefined
    ? gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, T, t.tex, 0)
    : gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, t.tex, 0, layer)

  const bind = (out, layer) => {
    const list = Array.isArray(out) ? out : out ? [out] : [], key = `${layer ?? ''}:${list.length}`
    if (list.length && !list[0].fbs[key]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, list[0].fbs[key] = gl.createFramebuffer())
      list.forEach((t, i) => attach(t, i, layer))
      gl.drawBuffers(list.map((_, i) => gl.COLOR_ATTACHMENT0 + i))
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, list.length ? list[0].fbs[key] : null)
  }

  const pass = ({p, at}, out, [w, h], inputs = {}, uniforms = {}, {layer, scissor} = {}) => {
    gl.useProgram(p)
    bind(out, layer)
    gl.viewport(0, 0, w, h)
    if (scissor) {gl.enable(gl.SCISSOR_TEST); gl.scissor(...scissor)}
    Object.entries(inputs).forEach(([name, t], i) => {gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(t.target, t.tex); gl.uniform1i(at(name), i)})
    for (const [name, [type, ...values]] of Object.entries(uniforms)) gl[`uniform${type}`](at(name), ...values)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    if (scissor) gl.disable(gl.SCISSOR_TEST)
  }

  const upload = (t, image, w, h) => {
    gl.bindTexture(T, t.tex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    if (image.data) gl.texSubImage2D(T, 0, 0, 0, w, h, t.kind === gl.R32F ? gl.RED : gl.RGBA, image.data instanceof Float32Array ? gl.FLOAT : gl.UNSIGNED_BYTE, image.data)
    else gl.texSubImage2D(T, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, image)
  }

  const read = (t, w = t.w, h = t.h) => {
    bind(t)
    const out = new Float32Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out)
    return out
  }

  return {gl, format, program, texture, grow, free, pass, upload, read, bytes: () => bytes}
}
