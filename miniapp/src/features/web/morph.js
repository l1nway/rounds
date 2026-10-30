import {useLayoutEffect, useRef} from 'react'

// [DOC: web-morph]
export const GROW = 640
export const SHRINK = 380
export const SETTLE = 'cubic-bezier(0.32, 0.72, 0, 1)'
export const EXIT = 'cubic-bezier(0.45, 0, 0.7, 0.4)'
const FADE = 140
const TINT = 300
const STAGGER = 50
const REVEAL = 0.32
const CIRCLE = 0.6
const TRAVEL = 0.4
const ROUND = 0.38
const LIFT = [{opacity: 0, transform: 'translateY(12px) scale(0.97)', filter: 'blur(6px)'}, {opacity: 1, transform: 'none', filter: 'none'}]

export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches
const spring = () => getComputedStyle(document.documentElement).getPropertyValue('--spring').trim() || SETTLE
let handoff = null
export const forget = () => {handoff = null}
const middle = r => [r.left + r.width / 2, r.top + r.height / 2]

export const shapeOf = el => {
  const rect = el.getBoundingClientRect(), style = getComputedStyle(el)
  const radius = Math.min(parseFloat(style.borderTopLeftRadius) || 0, rect.width / 2, rect.height / 2)
  return {rect, radius, color: style.backgroundColor}
}

const full = el => ({transform: 'none', clipPath: `inset(0 round ${getComputedStyle(el).borderTopLeftRadius})`})

const frame = (to, dx, dy, width, height, radius, offset) => ({
  transform: `translate(${dx}px, ${dy}px)`,
  clipPath: `inset(${Math.max(0, (to.height - height) / 2)}px ${Math.max(0, (to.width - width) / 2)}px round ${radius}px)`,
  ...offset && {offset}
})

// [DOC: web-morph-circle]
const shrunk = (el, {rect: from, radius}, offset) => {
  const to = el.getBoundingClientRect()
  const [fx, fy] = middle(from), [tx, ty] = middle(to)
  const start = frame(to, fx - tx, fy - ty, from.width, from.height, radius)
  if (radius < Math.min(from.width, from.height) / 2 - 0.5) return [start]
  const side = Math.min(to.width, to.height) * CIRCLE
  return [start, frame(to, (fx - tx) * TRAVEL, (fy - ty) * TRAVEL, side, side, side / 2, offset)]
}

export function useMorph(card, origin, open) {
  const running = useRef([])
  const live = useRef(origin)
  const play = (el, frames, options) => {running.current.push(el.animate(frames, {fill: 'both', ...options}))}

  useLayoutEffect(() => {live.current = origin})

  useLayoutEffect(() => {
    const el = card.current, from = handoff ?? live.current()
    handoff = null
    if (!from || reduced()) play(el, {opacity: [0, 1], scale: [0.94, 1]}, {duration: reduced() ? 0 : GROW, easing: spring()})
    else {
      play(el, [...shrunk(el, from, ROUND), full(el)], {duration: GROW, easing: spring()})
      play(el, {backgroundColor: [from.color, getComputedStyle(el).backgroundColor]}, {duration: TINT, easing: SETTLE})
      ;[...el.children].forEach((part, i) => play(part, LIFT, {duration: 460, delay: GROW * REVEAL + i * STAGGER, easing: SETTLE}))
    }
    // [DOC: web-morph-handoff]
    return () => {handoff = shapeOf(el)}
  }, [card])

  useLayoutEffect(() => {
    const el = card.current
    if (open || !el) return
    const style = getComputedStyle(el)
    const now = {transform: style.transform, clipPath: style.clipPath === 'none' ? full(el).clipPath : style.clipPath, backgroundColor: style.backgroundColor}
    const parts = [...el.children].map(part => [part, getComputedStyle(part).opacity])
    running.current.forEach(animation => animation.cancel())
    running.current = []
    parts.forEach(([part, opacity]) => play(part, {opacity: [opacity, 0]}, {duration: FADE, easing: 'ease-out'}))
    const to = live.current()
    if (!to || reduced()) play(el, {opacity: [1, 0], scale: [1, 0.94]}, {duration: reduced() ? 0 : SHRINK, easing: EXIT})
    else {
      play(el, [now, ...shrunk(el, to, 1 - ROUND).toReversed()], {duration: SHRINK, easing: EXIT})
      play(el, {backgroundColor: [now.backgroundColor, to.color]}, {duration: SHRINK / 2, delay: SHRINK / 2, easing: 'ease-in'})
    }
  }, [card, open])
}

export function useScrim(open, mounted) {
  const scrim = useRef(null)
  useLayoutEffect(() => {
    const el = scrim.current
    if (!el) return
    const from = getComputedStyle(el, '::before').opacity
    el.getAnimations({subtree: true}).forEach(animation => animation.effect?.pseudoElement === '::before' && animation.cancel())
    const duration = reduced() ? 0 : open ? GROW : SHRINK
    el.animate({opacity: [from, open ? 1 : 0]}, {pseudoElement: '::before', duration, easing: open ? SETTLE : EXIT, fill: 'forwards'})
  }, [open, mounted])
  return scrim
}
