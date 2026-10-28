import {memo, useEffect, useLayoutEffect, useRef, useState} from 'react'
import {LOOK, STAGE_EVENTS, split} from '../../constants/look.js'
import {usePlayer} from '../../hooks/player.js'
import {useOnline, usePresence} from '../../hooks/state.js'
import {lookFrame} from '../../services/api.js'
import {createLook} from './look-gl.js'

// [DOC: single-flight]
const DEBOUNCE = 350
const HDR = ['hlg', 'pq']
// [DOC: look-context]
const gpu = {canvas: null, draw: null, broken: false, shot: null, notify: null}

const make = () => {
  try {gpu.draw = createLook(gpu.canvas)} catch (error) {gpu.draw = null; console.warn('Look preview off:', error.message)}
  gpu.notify?.()
}

const setup = () => {
  if (gpu.canvas) return
  gpu.canvas = document.createElement('canvas')
  gpu.canvas.addEventListener('webglcontextlost', event => {event.preventDefault(); gpu.draw = null; gpu.notify?.()})
  gpu.canvas.addEventListener('webglcontextrestored', make)
  make()
}

const render = (video, params, alpha) => {
  if (!gpu.draw || gpu.broken) return false
  try {return gpu.draw(video, {...params, alpha})} catch {gpu.broken = true; gpu.notify?.(); return false}
}

// [DOC: lift-source]
const emit = stage => stage?.dispatchEvent(new CustomEvent(STAGE_EVENTS.paint, {detail: gpu.shot ?? (gpu.canvas.isConnected ? gpu.canvas : null)}))

const paint = ({host, params}, {video, stage}, alpha) => {
  if (!render(video, params, alpha)) return gpu.canvas.remove()
  if (!gpu.canvas.isConnected) host?.prepend(gpu.canvas)
  if (video.paused) emit(stage)
}

// [DOC: look-preview]
export default memo(function Look({job, look, exposure, adjusting, refs, dispatch}) {
  const own = useRef({host: null, params: null, want: null, flying: false, queued: false, alive: false})
  const [, setTick] = useState(0)
  const [host] = useState(() => el => {own.current.host = el})  // [DOC: stable-refs]
  useState(setup)
  const [frame, setFrame] = useState(null)
  const online = useOnline()
  const paused = usePlayer(state => state.paused)
  const still = usePlayer(state => state.paused ? state.time : null)
  const [t, r] = split(look)
  const hdr = Number(HDR.includes(job.meta.transfer))
  const ok = Boolean(gpu.draw) && !gpu.broken
  // [DOC: exact-frame]
  const key = r > 0 && still !== null && !adjusting ? `${still}:${look}:${exposure}` : null
  const shown = frame?.key === key ? frame : null
  const [mounted, shot] = usePresence(Boolean(shown))
  const [last, setLast] = useState(shown)
  if (shown && shown !== last) setLast(shown)
  const [settled, setSettled] = useState(null)
  const [waiting, wait] = usePresence(!shown && key !== null && online && settled !== key)

  useLayoutEffect(() => {
    const {stage} = refs.current
    const ask = () => paint(own.current, refs.current, 1)
    gpu.notify = () => setTick(n => n + 1)
    stage.addEventListener(STAGE_EVENTS.ask, ask)
    return () => {gpu.notify = null; gpu.shot = null; gpu.canvas.remove(); stage.removeEventListener(STAGE_EVENTS.ask, ask); emit(stage)}
  }, [refs])

  useLayoutEffect(() => {
    own.current.params = {t, ev: exposure, hdr}
    paint(own.current, refs.current, paused ? 1 : 0)
  }, [refs, ok, t, exposure, hdr, paused])

  useEffect(() => {
    if (!ok) return
    const {video} = refs.current
    let id = 0
    let media = null
    const next = (now, meta) => {
      const dt = meta.mediaTime - media
      media = meta.mediaTime
      paint(own.current, refs.current, video.paused || !(dt > 0 && dt < 1) ? 1 : 1 - Math.exp(-dt / LOOK.TAU))
      id = video.requestVideoFrameCallback(next)
    }
    const seeked = () => paint(own.current, refs.current, 1)
    id = video.requestVideoFrameCallback(next)
    video.addEventListener('seeked', seeked)
    return () => {video.cancelVideoFrameCallback(id); video.removeEventListener('seeked', seeked)}
  }, [refs, ok])

  // [DOC: single-flight]
  const [fly] = useState(() => function fly() {
    const o = own.current, want = o.want
    if (!want || !o.alive) return
    if (o.flying) {o.queued = true; return}
    o.flying = true
    o.queued = false
    dispatch({previewing: true})
    lookFrame(want.id, want.body).catch(() => ({})).then(async ({image}) => {
      const img = image && Object.assign(new Image(), {src: image})
      const ok = img && await img.decode().then(() => true, () => false)
      o.flying = false
      if (!o.alive) return
      if (ok && want === o.want) setFrame({key: want.key, img})
      setSettled(want.key)
      if (o.queued && o.want && o.want !== want) fly()
      else dispatch({previewing: false})
    })
  })

  useLayoutEffect(() => {
    const o = own.current
    o.alive = true
    return () => {o.alive = false; o.want = null; dispatch({previewing: false})}
  }, [dispatch])

  useEffect(() => {
    const o = own.current
    o.want = key && online ? {key, id: job.id, body: {time: still, look, exposure}} : null
    if (!o.want) return
    const timer = setTimeout(fly, DEBOUNCE)
    return () => clearTimeout(timer)
  }, [fly, key, online, job.id, still, look, exposure])

  useLayoutEffect(() => {
    gpu.shot = shown?.img ?? null
    if (shown) emit(refs.current.stage)
    else paint(own.current, refs.current, 1)
  }, [refs, shown])

  return (ok || mounted) && (
    <div ref={host} className='viewer-look' aria-hidden='true'>
      {mounted && <img ref={shot} className='viewer-look-shot' src={(shown ?? last).img.src} alt=''/>}
      {waiting && (
        <svg ref={wait} className='viewer-ai' viewBox='0 0 24 24' width='22' height='22'>
          <path d='M12 1.5c.6 5.6 4.9 9.9 10.5 10.5-5.6.6-9.9 4.9-10.5 10.5C11.4 16.9 7.1 12.6 1.5 12 7.1 11.4 11.4 7.1 12 1.5Z'/>
        </svg>
      )}
    </div>
  )
})
