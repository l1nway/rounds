import {createStore} from './state.js'

export const FPS = 30
export const MIN_RANGE = 1
export const ms = t => Math.round(t * 1000) / 1000
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
// [DOC: frame-times]
export const frameOf = t => Math.floor(t * FPS + 1e-3)
export const frameTime = k => Math.ceil(k / FPS * 1000 - 1e-6) / 1000

const pad = (n, size) => String(n).padStart(size, '0')
export const formatTime = t => {
  const total = Math.round(t * 1000)
  return `${Math.floor(total / 60000)}:${pad(Math.floor(total / 1000) % 60, 2)}.${pad(total % 1000, 3)}`
}

const store = createStore({time: 0, paused: true, waiting: true, loaded: false, failed: false, parked: false, hash: null})
const live = {video: null, target: null, busy: false, loop: 0, frame: 0, start: 0, end: Infinity}

export const usePlayer = store.use
export const useAway = time => usePlayer(state => time !== null && frameOf(state.time) !== frameOf(time))
export const getTime = () => store.get().time
// [DOC: watch-player]
export const watchPlayer = fn => store.subscribe(() => fn(store.get()))
export const setRange = (start, end) => {live.start = start; live.end = end}

// [DOC: seek-coalescing]
const flush = () => {
  const {video, target} = live
  if (!video || target === null || live.busy || video.readyState < 1) return
  live.busy = true
  live.target = null
  video.currentTime = target
}

const later = () => {
  if (live.frame) return
  live.frame = requestAnimationFrame(() => setTimeout(() => {live.frame = 0; flush()}))
}

export const seek = t => {
  live.video?.pause()
  live.target = t
  store.set({time: t})
  later()
}

export const hold = () => {if (!store.get().paused) seek(frameTime(frameOf(getTime())))}

export const step = dir => seek(clamp(frameTime(frameOf(getTime()) + dir), live.start, live.end))

const stop = () => {
  const {video, loop} = live
  if (!loop) return
  if (video && 'cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(loop)
  else cancelAnimationFrame(loop)
  live.loop = 0
}

// [DOC: playback-clock]
const track = () => {
  const {video} = live
  const next = (now, meta) => {
    const time = meta?.mediaTime ?? video.currentTime
    if (time < live.end) {store.set({time}); return track()}
    live.loop = 0
    seek(live.end)
  }
  live.loop = 'requestVideoFrameCallback' in video ? video.requestVideoFrameCallback(next) : requestAnimationFrame(next)
}

export const toggle = () => {
  const {video} = live
  if (!video) return
  if (!video.paused) return video.pause()
  if (getTime() >= live.end - 1 / FPS || getTime() < live.start) seek(live.start)
  video.play().catch(() => store.set({paused: true}))
}

// [DOC: player-park]
const HASH = {from: 256, side: 8, out: 32}
const SETTLE = 1500
const RELOAD = 10000
const rest = {count: 0, nap: null, waking: Promise.resolve(), video: null, src: null, time: 0}

const canvasOf = ([width, height]) => Object.assign(document.createElement('canvas'), {width, height})

// [DOC: player-hash]
const hashOf = video => {
  const {videoWidth: w, videoHeight: h} = video
  const fit = side => [w, h].map(v => Math.max(1, Math.round(v * side / Math.max(w, h))))
  const mip = canvasOf(fit(HASH.from)), out = canvasOf(fit(HASH.out)), a = mip.getContext('2d'), b = out.getContext('2d')
  a.imageSmoothingQuality = b.imageSmoothingQuality = 'high'
  a.drawImage(video, 0, 0, mip.width, mip.height)
  a.globalCompositeOperation = 'copy'
  let side = HASH.from
  for (; side > HASH.side; side /= 2) a.drawImage(mip, 0, 0, ...fit(side), 0, 0, ...fit(side / 2))
  b.drawImage(mip, 0, 0, ...fit(side), 0, 0, out.width, out.height)
  try {return out.toDataURL('image/png')} finally {mip.width = mip.height = out.width = out.height = 0}
}

const within = (promise, limit) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, limit))])
// [DOC: park-lull]
const lull = () => new Promise(resolve => setTimeout(resolve, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-long')) || 0))
const settle = video => within(new Promise(resolve => setTimeout(resolve)).then(() => Promise.all(video.getAnimations().map(a => a.finished.catch(() => {})))), SETTLE)

const shown = video => new Promise(resolve => {
  const events = ['seeked', 'loadeddata', 'error']
  const done = event => {
    if (event.type !== 'error' && (video.readyState < 2 || video.seeking)) return
    events.forEach(type => video.removeEventListener(type, done))
    resolve()
  }
  events.forEach(type => video.addEventListener(type, done))
})

const sleep = async () => {
  await lull()
  const {video} = live
  if (!video || video.readyState < 2) return
  video.pause()
  let hash
  try {hash = hashOf(video)} catch {return}
  store.set({hash, parked: true})
  await settle(video)
  if (live.video !== video) return store.set({hash: null, parked: false})
  Object.assign(rest, {video, src: video.getAttribute('src'), time: getTime()})
  video.removeAttribute('src')
  video.load()
}

const wake = async () => {
  const {video, src, time} = rest
  rest.video = null
  if (video && live.video === video) {
    if (live.target === null) live.target = time
    video.setAttribute('src', src)
    await within(shown(video), RELOAD)
  }
  if (!store.get().parked) return
  store.set({parked: false})
  if (live.video) await settle(live.video)
  if (!rest.count) store.set({hash: null})
}

export const parked = async work => {
  try {
    if (!rest.count++) rest.nap = rest.waking.then(sleep)
    await rest.nap
    return await work()
  } finally {if (!--rest.count) rest.waking = wake()}
}

export const attach = video => {
  live.video = video
  if (!video) return () => {}
  store.set({waiting: true, loaded: false, failed: false})
  const handlers = {
    loadedmetadata: () => {
      try {if (video.currentTime === 0) video.currentTime = 0.001} catch {}
      flush()
    },
    loadeddata: () => store.set({waiting: false, loaded: true, failed: false}),
    error: () => {
      if (import.meta.env.DEV) console.warn('Video playback error:', video.error?.code, video.error?.message)
      store.set({waiting: false, failed: true})
    },
    seeking: () => store.set({waiting: true}),
    seeked: () => {live.busy = false; store.set({waiting: false}); flush()},
    waiting: () => store.set({waiting: true}),
    playing: () => store.set({waiting: false}),
    play: () => {store.set({paused: false}); stop(); track()},
    pause: () => {store.set({paused: true}); stop()},
    emptied: () => {live.busy = false}
  }
  Object.entries(handlers).forEach(([type, fn]) => video.addEventListener(type, fn))
  if (video.readyState >= 2) store.set({waiting: false, loaded: true, failed: false})
  flush()
  return () => {
    stop()
    cancelAnimationFrame(live.frame)
    live.frame = 0
    Object.entries(handlers).forEach(([type, fn]) => video.removeEventListener(type, fn))
    live.video = null
  }
}
