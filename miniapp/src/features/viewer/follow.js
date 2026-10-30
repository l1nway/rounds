import {useEffect, useRef, useState} from 'react'
import {frameOf, watchPlayer} from '../../hooks/player.js'
import {createStore} from '../../hooks/state.js'
import {segment, track, warmLift} from '../../services/api.js'

const DELAY = 600
const SLACK = 0.2
const WARM_GAP = 90000

const centre = box => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]

// [DOC: follow]
const centreAt = ({fps, start, boxes}, t) => {
  const x = (t - start) * fps, i = Math.floor(x), f = x - i
  const a = boxes[i], b = boxes[i + 1]
  if (a && b) return centre(a).map((v, k) => v + (centre(b)[k] - v) * f)
  const near = f < 0.5 ? a : b
  return near ? centre(near) : null
}

const place = (el, path, {time, paused}) => {
  const c = path && frameOf(time) !== frameOf(path.time) && centreAt(path, time)
  const c0 = c && centreAt(path, path.time)
  const shift = c0 ? `${(c[0] - c0[0]) * 100}% ${(c[1] - c0[1]) * 100}%` : ''
  if (el.style.translate === shift) return
  el.toggleAttribute('data-follow', Boolean(shift))
  el.toggleAttribute('data-glide', paused)
  el.style.translate = shift
}

// [DOC: ai-progress]
export const progress = createStore({lift: null, follow: null})
const reporter = kind => info => progress.set({[kind]: info})

// [DOC: follow-confirm]
export function useFollow(id, selection, mask, pending, start, end) {
  const {time, points, box} = selection
  const own = useRef({want: null, busy: false, path: null, el: null, state: {time: 0, paused: true}})
  const [status, setStatus] = useState(null)
  const phase = status?.selection === selection ? status.phase : null
  const going = phase === 'tracking' || phase === 'tracked'

  // [DOC: single-flight]
  const [send] = useState(() => function send() {
    const o = own.current, want = o.want
    if (o.busy || !want) return
    o.busy = true
    const {id: job, selection, start, end, ...prompt} = want
    setStatus({selection, phase: 'tracking'})
    // [DOC: ai-progress]
    if (typeof job !== 'function') progress.set({follow: {label: 'Tracking object…'}})
    const req = typeof job === 'function' ? job({start, end, prompt}, reporter('follow')) : track(job, {start, end, prompt})
    req.catch(error => {if (import.meta.env.DEV) console.warn(error); return null}).then(answer => {
      o.busy = false
      progress.set({follow: null})
      if (o.want !== want) return send()
      o.want = null
      o.path = answer?.boxes?.length ? {...answer, time: want.time, points: want.points, box: want.box} : null
      setStatus(prev => prev?.selection === selection ? {selection, phase: o.path ? 'tracked' : 'failed'} : prev)
      if (o.el) place(o.el, o.path, o.state)
    })
  })

  const asked = box || points.some(p => p[2] === 1)
  useEffect(() => {
    const o = own.current
    if (o.path && (o.path.time !== time || o.path.points !== points || o.path.box !== box)) o.path = null
    if (o.el) place(o.el, o.path, o.state)
    const {path} = o, covered = path && path.start <= start + SLACK && path.start + (path.boxes.length - 1) / path.fps >= end - SLACK
    if (!id || time === null || !asked || pending || covered || !going) {o.want = null; return}
    o.want = {id, selection, time, points, box, mask, start, end}
    const timer = setTimeout(send, path ? DELAY : 0)
    return () => clearTimeout(timer)
  }, [send, id, selection, time, points, box, mask, pending, asked, start, end, going])

  const confirm = () => setStatus({selection, phase: 'tracking'})
  const stop = () => {
    const o = own.current
    if (o.busy) id?.stop?.()
    o.want = o.path = null
    progress.set({follow: null})
    setStatus(null)
    if (o.el) place(o.el, null, o.state)
  }

  useEffect(() => watchPlayer(state => {
    const o = own.current
    o.state = state
    if (o.el) place(o.el, o.path, state)
  }), [])

  const [attach] = useState(() => el => {
    const o = own.current
    o.el = el
    if (el) place(el, o.path, o.state)
  })
  return {attach, phase, confirm, stop}
}

const prefilled = job => {
  const prompt = job?.request?.prompt
  return prompt?.mask ? {time: prompt.time, candidates: [{mask: prompt.mask}], index: 0, best: 0} : null
}
const asks = ({points, box}) => Boolean(box) || points.some(p => p[2] === 1)

// [DOC: lift]
export function useLift(job, dispatch, readOnly) {
  const [lift, setLift] = useState(null)
  const [seen, setSeen] = useState(job)
  const flight = useRef({want: null, busy: false})
  const id = job?.lift ?? (job?.tier === 'free' ? null : job?.id)  // [DOC: tiers]
  if (job !== seen) {setSeen(job); setLift(prefilled(job))}

  useEffect(() => {
    if (typeof id !== 'string' || readOnly) return
    let last = 0
    const wake = () => {
      if (document.visibilityState !== 'visible' || Date.now() - last < WARM_GAP) return
      last = Date.now()
      warmLift(id).catch(() => {})
    }
    wake()
    document.addEventListener('visibilitychange', wake)
    return () => document.removeEventListener('visibilitychange', wake)
  }, [id, readOnly])

  // [DOC: single-flight]
  const send = () => {
    const f = flight.current, want = f.want
    if (f.busy || !want) return
    f.busy = true
    if (typeof id !== 'function') progress.set({lift: {label: 'Selecting object…'}})
    ;(typeof id === 'function' ? id(want, reporter('lift')) : segment(id, want)).catch(() => null).then(answer => {
      f.busy = false
      progress.set({lift: null})
      if (f.want !== want) return send()
      f.want = null
      const {candidates = [], best = 0} = answer ?? {}
      setLift(candidates.length ? {time: want.time, candidates, index: best, best} : null)
      dispatch({mask: candidates[best]?.mask ?? null})
    })
  }

  const ask = selection => {
    dispatch({mask: null})
    flight.current.want = null
    if (!asks(selection) || !id) return setLift(null)
    const {time, points, box} = selection
    setLift(prev => prev?.time === time ? {...prev, pending: true} : {time, candidates: [], index: 0, best: 0, pending: true})
    flight.current.want = {time, points, box}
    send()
  }

  const cycle = () => {
    const {candidates = [], index, best, pending} = lift ?? {}
    const next = (index + 1) % candidates.length
    if (pending || candidates.length < 2 || next === best) return false
    setLift({...lift, index: next})
    dispatch({mask: candidates[next].mask})
    return true
  }

  return {lift, ask, cycle}
}
