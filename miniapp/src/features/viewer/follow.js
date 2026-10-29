import {useEffect, useRef, useState} from 'react'
import {frameOf, watchPlayer} from '../../hooks/player.js'
import {track} from '../../services/api.js'

const DELAY = 600
const SLACK = 0.2

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

export function useFollow(id, {time, points, box}, mask, pending, start, end) {
  const own = useRef({want: null, busy: false, path: null, el: null, state: {time: 0, paused: true}})

  // [DOC: single-flight]
  const [send] = useState(() => function send() {
    const o = own.current, want = o.want
    if (o.busy || !want) return
    o.busy = true
    const {id: job, start, end, ...prompt} = want
    const req = typeof job === 'function' ? job({start, end, prompt}) : track(job, {start, end, prompt})
    req.catch(error => {console.warn(error); return null}).then(answer => {
      o.busy = false
      if (o.want !== want) return send()
      o.want = null
      o.path = answer?.boxes?.length ? {...answer, time: want.time, points: want.points, box: want.box} : null
      if (o.el) place(o.el, o.path, o.state)
    })
  })

  const asked = box || points.some(p => p[2] === 1)
  useEffect(() => {
    const o = own.current
    if (o.path && (o.path.time !== time || o.path.points !== points || o.path.box !== box)) o.path = null
    if (o.el) place(o.el, o.path, o.state)
    const {path} = o, covered = path && path.start <= start + SLACK && path.start + (path.boxes.length - 1) / path.fps >= end - SLACK
    if (!id || time === null || !asked || pending || covered) {o.want = null; return}
    o.want = {id, time, points, box, mask, start, end}
    const timer = setTimeout(send, DELAY)
    return () => clearTimeout(timer)
  }, [send, id, time, points, box, mask, pending, asked, start, end])

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
  return attach
}
