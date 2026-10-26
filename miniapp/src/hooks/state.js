import {useLayoutEffect, useRef, useState, useSyncExternalStore} from 'react'

export const merge = (prev, next) => {
  const patch = typeof next === 'function' ? next(prev) : next
  for (const key in patch) if (!Object.is(prev[key], patch[key])) return {...prev, ...patch}
  return prev
}

export const createStore = initial => {
  let state = initial
  const subs = new Set()
  const subscribe = fn => {subs.add(fn); return () => subs.delete(fn)}
  const set = patch => {
    const next = merge(state, patch)
    if (next !== state) {state = next; subs.forEach(fn => fn())}
  }
  return {get: () => state, set, use: select => useSyncExternalStore(subscribe, () => select(state))}
}

const onNetwork = fn => {
  window.addEventListener('online', fn)
  window.addEventListener('offline', fn)
  return () => {window.removeEventListener('online', fn); window.removeEventListener('offline', fn)}
}

// [DOC: offline]
export const useOnline = () => useSyncExternalStore(onNetwork, () => navigator.onLine, () => true)

const running = el => el.getAnimations().filter(a => a.playState !== 'finished' && a.effect.getComputedTiming().endTime !== Infinity)
const settle = el => {
  const list = running(el)
  return list.length ? Promise.allSettled(list.map(a => a.finished)).then(() => settle(el)) : Promise.resolve()
}

// [DOC: presence]
export const leave = el => {
  el.dataset.leaving = ''
  return settle(el)
}

export function useLeave(on, done) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (on || !el) return
    let live = true
    leave(el).then(() => live && done())
    return () => {live = false; delete el.dataset.leaving}
  }, [on, done])
  return ref
}

export function usePresence(show) {
  const [mounted, setMounted] = useState(show)
  const [hide] = useState(() => () => setMounted(false))
  if (show && !mounted) setMounted(true)
  return [mounted || show, useLeave(show, hide)]
}
