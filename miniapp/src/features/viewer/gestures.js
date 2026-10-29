import {clamp, frameOf, frameTime, getTime, hold} from '../../hooks/player.js'
import {haptic} from '../../services/telegram.js'

const TAP = 8
const HIT = 24
const MIN_BOX = 12
const DOUBLE = 350

const round = value => Math.round(value * 1e4) / 1e4
const norm = (x, y, rect) => [round(clamp((x - rect.left) / rect.width, 0, 1)), round(clamp((y - rect.top) / rect.height, 0, 1))]
export const pct = value => `${value * 100}%`
export const boxStyle = ([x0, y0, x1, y1]) => ({left: pct(x0), top: pct(y0), width: pct(x1 - x0), height: pct(y1 - y0)})

const span = ([ax, ay], [bx, by], rect) => {
  const [x0, y0] = norm(ax, ay, rect)
  const [x1, y1] = norm(bx, by, rect)
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
}

const shifted = ([x0, y0, x1, y1], dx, dy) => {
  const sx = clamp(dx, -x0, 1 - x1)
  const sy = clamp(dy, -y0, 1 - y1)
  return [x0 + sx, y0 + sy, x1 + sx, y1 + sy].map(round)
}

// [DOC: box-edit]
const grab = (box, x, y, rect) => {
  const [l, t, r, b] = box.map((v, i) => i % 2 ? rect.top + v * rect.height : rect.left + v * rect.width)
  const reach = Math.min(HIT, (r - l) / 3, (b - t) / 3)
  const fx = Math.abs(x - l) < reach ? r : Math.abs(x - r) < reach ? l : null
  const fy = Math.abs(y - t) < reach ? b : Math.abs(y - b) < reach ? t : null
  if (fx !== null && fy !== null) return {from: [fx, fy], edit: true}
  return x > l && x < r && y > t && y < b ? {shift: box, edit: true} : {}
}

// [DOC: selection-gestures]
export function useGestures({job, selection, dispatch, readOnly, refs, ask, cycle}) {
  const {time, points, box} = selection

  const select = patch => {haptic.tap(); dispatch(patch); ask({...selection, ...patch})}
  const frame = () => {
    const now = frameTime(frameOf(getTime()))
    return {now, same: time !== null && frameOf(time) === frameOf(now)}
  }

  const tap = ([x, y], rect) => {
    const {now, same} = frame()
    const mark = [x, y, 1]
    if (!same) return select({time: now, points: [mark], box: null})
    const hit = points.findIndex(([px, py]) => Math.hypot((px - x) * rect.width, (py - y) * rect.height) < HIT)
    if (hit < 0) return select({points: [...points, mark]})
    if (cycle()) return haptic.tap()
    const rest = points.filter((_, i) => i !== hit)
    select({points: rest, time: rest.length || box ? time : null})
  }

  const drawBox = value => {
    const {now, same} = frame()
    select(same ? {box: value} : {time: now, box: value, points: []})
  }

  const hide = () => {
    const {draw, stage} = refs.current
    refs.current.drag = null
    if (draw) draw.hidden = true
    if (stage) delete stage.dataset.editing
  }

  const down = event => {
    if (readOnly || !job || !event.isPrimary || event.button > 0) return
    hold()
    try {event.currentTarget.setPointerCapture(event.pointerId)} catch {}
    const rect = event.currentTarget.getBoundingClientRect()
    const {clientX: x, clientY: y} = event
    const handle = box && frame().same ? grab(box, x, y, rect) : {}
    refs.current.drag = {rect, x, y, from: [x, y], box: null, ...handle}
  }

  const move = event => {
    const {drag, draw, stage} = refs.current
    if (!drag || (!drag.box && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < TAP)) return
    const {rect, shift, from, edit} = drag
    drag.box = shift
      ? shifted(shift, (event.clientX - drag.x) / rect.width, (event.clientY - drag.y) / rect.height)
      : span(from, [event.clientX, event.clientY], rect)
    if (draw) Object.assign(draw.style, boxStyle(drag.box))
    if (draw) draw.hidden = false
    if (edit) stage.dataset.editing = ''
  }

  // [DOC: box-reset]
  const reset = (event, shift) => {
    const {tapped} = refs.current
    const twice = shift && tapped && event.timeStamp - tapped.at < DOUBLE && Math.hypot(event.clientX - tapped.x, event.clientY - tapped.y) < HIT
    refs.current.tapped = !twice && shift ? {at: event.timeStamp, x: event.clientX, y: event.clientY, points} : null
    if (twice) select({box: null, points: tapped.points, time: tapped.points.length ? time : null})
    return twice
  }

  const up = event => {
    const {drag} = refs.current
    hide()
    if (!drag) return
    if (!drag.box) return reset(event, drag.shift) || tap(norm(event.clientX, event.clientY, drag.rect), drag.rect)
    refs.current.tapped = null
    const [x0, y0, x1, y1] = drag.box
    if ((x1 - x0) * drag.rect.width >= MIN_BOX && (y1 - y0) * drag.rect.height >= MIN_BOX) drawBox(drag.box)
  }

  return {down, move, up, hide}
}
