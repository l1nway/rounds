import {useEffect, useRef, useState} from 'react'
import './slider.css'

const PULL = 15
const STIFFNESS = 320
const DAMPING = 18
const SETTLE_POS = 0.1
const SETTLE_VEL = 1
const PRESS = 1.15
const SLOP = 8
const DOUBLE = 350

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const rubber = (d, max) => max * (1 - 1 / (d / max + 1))
const percentOf = (value, min, max) => (value - min) / (max - min) * 100

// [DOC: slider]
export default function Slider({value, min = 0, max = 100, step = 1, origin = min, locked, disabled, onChange, onDrag, reset, ...props}) {
  const track = useRef(null)
  const thumb = useRef(null)
  const live = useRef({raf: 0, drag: null, width: 0, tap: null, visual: {x: 0, y: 0, scale: 1}})
  const [mode, setMode] = useState(null)
  const off = disabled || locked

  const stop = () => {cancelAnimationFrame(live.current.raf); live.current.raf = 0}
  useEffect(() => stop, [])

  const valueAt = percent => clamp(Number((Math.round(percent / 100 * (max - min) / step) * step + min).toFixed(6)), min, max)

  // [DOC: slider-stretch]
  const render = () => {
    const {x, y, scale} = live.current.visual
    const ox = x - clamp(x, 0, live.current.width)
    const len = Math.hypot(ox, y)
    const s = Math.min(1, len / PULL)
    const c = len ? ox / len : 1, n = len ? y / len : 0
    const a = scale * (1 + s * 0.25), b = scale * (1 - s * 0.175)
    const k = (a - b) * c * n
    thumb.current.style.transform = `translate(-50%, -50%) matrix(${a * c * c + b * n * n}, ${k}, ${k}, ${a * n * n + b * c * c}, ${x}, ${y})`
  }

  const loop = tick => {
    let last = performance.now()
    const frame = now => {
      const dt = Math.min((now - last) / 1000, 0.032)
      last = now
      if (tick(dt)) {live.current.raf = 0; return}
      render()
      live.current.raf = requestAnimationFrame(frame)
    }
    live.current.raf = requestAnimationFrame(frame)
  }

  const pointAt = (clientX, clientY) => {
    const {left, y0} = live.current.drag, {width} = live.current
    const raw = clientX - left
    const clamped = clamp(raw, 0, width)
    const dx = raw - clamped, dy = clientY - y0
    const len = Math.hypot(dx, dy)
    const f = len ? rubber(len, PULL) / len : 0
    return {percent: clamped / width * 100, x: clamped + dx * f, y: dy * f}
  }

  const move = event => {
    const d = live.current.drag
    if (d?.id !== event.pointerId) return
    const {percent, x, y} = pointAt(event.clientX, event.clientY)
    d.moved ||= Math.abs(event.clientX - d.x0) > SLOP
    const next = valueAt(percent)
    if (next !== d.value) {d.value = next; onChange(next)}
    Object.assign(live.current.visual, {x, y})
    d.samples = [d.samples[1], {x, y, t: event.timeStamp}]
    render()
  }

  const down = event => {
    if (off || !event.isPrimary || event.button > 0) return
    event.preventDefault()
    stop()
    thumb.current.focus({preventScroll: true})
    const {left, width} = track.current.getBoundingClientRect()
    live.current.width = width
    live.current.drag = {id: event.pointerId, left, y0: event.clientY, x0: event.clientX, value, moved: false, samples: [null, null]}
    event.currentTarget.setPointerCapture(event.pointerId)
    thumb.current.style.left = '0'
    setMode('drag')
    onDrag?.(true)
    move(event)
    loop(dt => {
      const v = live.current.visual
      v.scale += (PRESS - v.scale) * Math.min(1, dt * 20)
      return Math.abs(v.scale - PRESS) < 0.01
    })
  }

  const up = event => {
    const d = live.current.drag
    if (d?.id !== event.pointerId) return
    live.current.drag = null
    stop()
    const tap = !d.moved && event.type === 'pointerup'
    const prev = live.current.tap
    const back = tap && reset && prev !== null && event.timeStamp - prev < DOUBLE
    live.current.tap = tap && !back ? event.timeStamp : null
    const target = percentOf(back ? origin : d.value, min, max) / 100 * live.current.width
    const [a, b] = d.samples
    const dt = a && b && b.t > a.t ? (b.t - a.t) / 1000 : 0
    let vx = dt && (b.x - a.x) / dt, vy = dt && (b.y - a.y) / dt
    if (back && d.value !== origin) onChange(origin)
    onDrag?.(false)
    setMode('settle')
    loop(dt => {
      const v = live.current.visual
      vx += (-STIFFNESS * (v.x - target) - DAMPING * vx) * dt
      vy += (-STIFFNESS * v.y - DAMPING * vy) * dt
      v.x += vx * dt
      v.y += vy * dt
      v.scale += (1 - v.scale) * Math.min(1, dt * 10)
      const done = Math.abs(v.x - target) < SETTLE_POS && Math.abs(v.y) < SETTLE_POS && Math.abs(vx) < SETTLE_VEL && Math.abs(vy) < SETTLE_VEL && Math.abs(v.scale - 1) < 0.01
      if (!done) return false
      live.current.visual = {x: target, y: 0, scale: 1}
      thumb.current.style.left = ''
      thumb.current.style.transform = ''
      setMode(null)
      return true
    })
  }

  const key = event => {
    const big = event.shiftKey ? step * 10 : step
    const next = {ArrowRight: value + big, ArrowUp: value + big, ArrowLeft: value - big, ArrowDown: value - big, Home: min, End: max}[event.key]
    if (next === undefined || off) return
    event.preventDefault()
    const snapped = valueAt(percentOf(clamp(next, min, max), min, max))
    if (snapped !== value) onChange(snapped)
  }

  const p = percentOf(value, min, max), o = percentOf(origin, min, max)
  return (
    <div className='slider' data-mode={mode || undefined} data-locked={locked || undefined} aria-disabled={disabled || undefined}
      style={{'--progress': `${p}%`, '--lo': `${Math.min(p, o)}%`, '--hi': `${Math.max(p, o)}%`}}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div ref={track} className='slider-track'>
        <div className='slider-fill'/>
        <div ref={thumb} className='slider-thumb' role='slider' tabIndex={disabled ? -1 : 0} onKeyDown={key} {...props}
          aria-valuemin={min} aria-valuemax={max} aria-valuenow={value} aria-disabled={off || undefined}/>
      </div>
    </div>
  )
}
