let holds = 0
let lock = null

// [DOC: local-awake]
const take = async () => {
  if (!holds || lock || document.hidden) return
  try {
    lock = await navigator.wakeLock?.request('screen')
    lock?.addEventListener('release', () => {lock = null})
  } catch {lock = null}
}

if (typeof document === 'object') document.addEventListener('visibilitychange', take)

export const awake = async work => {
  holds++
  take()
  try {return await work()} finally {
    if (!--holds) {lock?.release().catch(() => {}); lock = null}
  }
}
