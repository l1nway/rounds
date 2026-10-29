import {LOOK, split} from '../../constants/look.js'
import {createLook} from '../viewer/look-gl.js'

// [DOC: local-exposure]
export const grade = (value, ev, size, at = null, start = 0, fps = 30) => {
  const [t] = split(value)
  const glCanvas = (value || ev) ? document.createElement('canvas') : null
  const draw = glCanvas ? createLook(glCanvas) : null
  if (glCanvas && !draw) throw new Error('This browser cannot adjust HDR or exposure')
  const canvas = Object.assign(document.createElement('canvas'), {width: size, height: size, videoWidth: size, videoHeight: size, readyState: 4})
  const ctx = canvas.getContext('2d')
  let last = null
  return sample => {
    if (at) {
      const time = sample.timestamp >= start && start > 0 ? sample.timestamp - start : sample.timestamp
      const frame = Math.max(0, time * fps)
      const [cx, cy, side] = at(frame)
      const w = sample.displayWidth, h = sample.displayHeight
      const s = Math.min(side, w, h)
      const left = Math.max(0, Math.min(w - s, Math.round(cx - s / 2)))
      const top = Math.max(0, Math.min(h - s, Math.round(cy - s / 2)))
      sample.drawWithFit(ctx, {crop: {left, top, width: s, height: s}, fit: 'fill'})
    } else {
      sample.drawWithFit(ctx, {fit: 'fill'})
    }
    if (!draw) return canvas
    const dt = last === null ? 0 : sample.timestamp - last
    last = sample.timestamp
    if (!draw(canvas, {t, ev, hdr: 0, alpha: dt > 0 && dt < 1 ? 1 - Math.exp(-dt / LOOK.TAU) : 1})) return canvas
    ctx.drawImage(glCanvas, 0, 0)
    return canvas
  }
}
