const KEY = 'rounds-stale-reload'
const AGAIN = 30_000

const last = () => {
  try {return Number(sessionStorage.getItem(KEY)) || 0} catch {return 0}
}
const mark = () => {
  try {sessionStorage.setItem(KEY, String(Date.now()))} catch {}
}

// [DOC: stale-chunks]
export const reloadOnStaleChunk = () => window.addEventListener('vite:preloadError', () => {
  if (!navigator.onLine || Date.now() - last() < AGAIN) return
  mark()
  location.reload()
})

