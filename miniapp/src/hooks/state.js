import {useSyncExternalStore} from 'react'

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
