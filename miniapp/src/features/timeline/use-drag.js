import {useEffect, useMemo, useRef} from 'react'
import {frameOf} from '../../hooks/player.js'
import {haptic} from '../../services/telegram.js'

const HOLD = 400
const STILL = 6
const RATIOS = [1, 0.1, 0.01]

// [DOC: fine-scrub]
export default function useDrag(api, onMode) {
  const drag = useRef(null)
  useEffect(() => () => clearTimeout(drag.current?.timer), [])

  return useMemo(() => {
    const arm = d => {
      clearTimeout(d.timer)
      if (d.level === RATIOS.length - 1) return
      d.timer = setTimeout(() => {
        d.level += 1
        d.x0 = d.x
        d.v0 = api.current.read(d.kind)
        haptic.tap('medium')
        onMode({level: d.level, step: d.perPx * RATIOS[d.level]})
        arm(d)
      }, HOLD)
    }

    const down = event => {
      const {duration, read, write} = api.current
      if (!event.isPrimary || event.button > 0 || !duration) return
      const kind = event.target.closest('[data-kind]')?.dataset.kind
      const axis = event.currentTarget.getBoundingClientRect()
      const perPx = duration / axis.width
      event.currentTarget.setPointerCapture(event.pointerId)
      const v0 = kind ? read(kind) : write('play', (event.clientX - axis.left) * perPx)
      drag.current = {kind: kind ?? 'play', perPx, v0, x0: event.clientX, x: event.clientX, still: event.clientX, level: 0, frame: frameOf(v0), clamped: false, timer: 0}
      onMode({level: 0, step: perPx})
      arm(drag.current)
    }

    const move = event => {
      const d = drag.current
      if (!d) return
      d.x = event.clientX
      if (Math.abs(d.x - d.still) > STILL) {d.still = d.x; arm(d)}
      const raw = d.v0 + (d.x - d.x0) * d.perPx * RATIOS[d.level]
      const value = api.current.write(d.kind, raw)
      const clamped = value !== raw
      if (clamped) {d.v0 = value; d.x0 = d.x}
      if (clamped && !d.clamped) haptic.tap('rigid')
      d.clamped = clamped
      if (d.level && frameOf(value) !== d.frame) haptic.tick()
      d.frame = frameOf(value)
    }

    const up = () => {
      if (!drag.current) return
      clearTimeout(drag.current.timer)
      drag.current = null
      onMode(null)
    }

    return {onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up}
  }, [api, onMode])
}
