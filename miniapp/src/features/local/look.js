import {LOOK, split} from '../../constants/look.js'
import {createLook} from '../viewer/look-gl.js'

// [DOC: local-crop-draw]
const crop = (ctx, sample, left, top, s, size) => {
  const k = size / s
  ctx.imageSmoothingQuality = 'high'
  ctx.setTransform(sample.displayWidth * k / size, 0, 0, sample.displayHeight * k / size, -left * k, -top * k)
  sample.drawWithFit(ctx, {fit: 'fill'})
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

// [DOC: local-exposure]
export const toner = (value, ev, size) => {
  const [t] = split(value)
  const glCanvas = (value || ev) ? document.createElement('canvas') : null
  const draw = glCanvas ? createLook(glCanvas) : null
  if (glCanvas && !draw) throw new Error('This browser cannot adjust HDR or exposure')
  const canvas = Object.assign(document.createElement('canvas'), {width: size, height: size, videoWidth: size, videoHeight: size, readyState: 4})
  const ctx = canvas.getContext('2d')
  let last = null
  const tone = timestamp => {
    if (!draw) return canvas
    const dt = last === null ? 0 : timestamp - last
    last = timestamp
    if (draw(canvas, {t, ev, hdr: 0, alpha: dt > 0 && dt < 1 ? 1 - Math.exp(-dt / LOOK.TAU) : 1})) ctx.drawImage(glCanvas, 0, 0)
    return canvas
  }
  return {canvas, ctx, tone, on: Boolean(draw)}
}

export const grade = (value, ev, size, at, fps = 30) => {
  const {ctx, tone} = toner(value, ev, size)
  return sample => {
    // [DOC: local-crop-time]
    const [cx, cy, side] = at(Math.max(0, sample.timestamp * fps))
    const w = sample.displayWidth, h = sample.displayHeight
    const s = Math.min(side, w, h)
    crop(ctx, sample, Math.max(0, Math.min(w - s, Math.round(cx - s / 2))), Math.max(0, Math.min(h - s, Math.round(cy - s / 2))), s, size)
    return tone(sample.timestamp)
  }
}
