import {memo, useEffect, useLayoutEffect, useRef, useState} from 'react'
import Sheen from '../../components/sheen.jsx'
import {attach, clamp, frameOf, frameTime, getTime, hold, useAway, usePlayer} from '../../hooks/player.js'
import {useOnline} from '../../hooks/state.js'
import {segment, warmLift} from '../../services/api.js'
import {haptic} from '../../services/telegram.js'
import Lift from './lift.jsx'
import './viewer.css'

const TAP = 8
const HIT = 24
const MIN_BOX = 12
const FALLBACK_ASPECT = 16 / 9
const FIT = {duration: 600, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)'}
const BROKEN = {title: 'The video did not load', text: 'Check the connection and open the editor again.'}

const round = value => Math.round(value * 1e4) / 1e4
const norm = (x, y, rect) => [round(clamp((x - rect.left) / rect.width, 0, 1)), round(clamp((y - rect.top) / rect.height, 0, 1))]
const pct = value => `${value * 100}%`
const boxStyle = ([x0, y0, x1, y1]) => ({left: pct(x0), top: pct(y0), width: pct(x1 - x0), height: pct(y1 - y0)})
const prefilled = job => {
  const prompt = job?.request?.prompt
  return prompt?.mask ? {time: prompt.time, candidates: [{mask: prompt.mask}], index: 0, best: 0} : null
}
const asks = ({points, box}) => Boolean(box) || points.some(p => p[2] === 1)
const originOf = (points, box) => box ? [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] : points[0]

// [DOC: viewer-fit]
function useFit(ref, aspect) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!aspect || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    delete el.dataset.fit
    const from = el.offsetHeight
    el.dataset.fit = ''
    el.animate({height: [`${from}px`, `${el.offsetHeight}px`], '--aspect': [FALLBACK_ASPECT, aspect]}, FIT)
  }, [ref, aspect])
}

// [DOC: lift]
function useLift(job, dispatch, readOnly) {
  const [lift, setLift] = useState(null)
  const [seen, setSeen] = useState(job)
  const latest = useRef(0)
  const id = job?.id
  if (job !== seen) {setSeen(job); setLift(prefilled(job))}

  useEffect(() => {
    if (!id || readOnly) return
    const wake = () => {if (document.visibilityState === 'visible') warmLift(id).catch(() => {})}
    wake()
    document.addEventListener('visibilitychange', wake)
    return () => document.removeEventListener('visibilitychange', wake)
  }, [id, readOnly])

  const ask = selection => {
    const n = ++latest.current
    dispatch({mask: null})
    if (!asks(selection)) return setLift(null)
    const {time, points, box} = selection
    setLift(prev => prev?.time === time ? {...prev, pending: true} : {time, candidates: [], index: 0, best: 0, pending: true})
    segment(id, {time, points, box}).then(({candidates, best}) => {
      if (n !== latest.current) return
      setLift(candidates.length ? {time, candidates, index: best, best} : null)
      dispatch({mask: candidates[best]?.mask ?? null})
    }, () => {if (n === latest.current) setLift(null)})
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

// [DOC: selection-frame]
const Marks = memo(function Marks({time, points, box, pending}) {
  const away = useAway(time)
  return (
    <div className='viewer-marks' data-away={away || undefined} data-pending={pending || undefined} aria-hidden='true'>
      {box && <div className='viewer-box' style={boxStyle(box)}/>}
      {points.map(([x, y, label]) => <i key={`${x}:${y}`} className='viewer-point' data-negative={!label || undefined} style={{left: pct(x), top: pct(y)}}/>)}
    </div>
  )
})

// [DOC: loading-crossfade]
function Notice({notice}) {
  const online = useOnline()
  const [last, setLast] = useState(notice)
  const [first] = useState(notice?.title)
  if (notice && notice !== last) setLast(notice)
  const {title, text, busy, action, onAction} = notice ?? last ?? {}
  return (
    <div className='viewer-notice' role='status' data-busy={busy || undefined} data-off={!notice || undefined}>
      {busy && <Sheen on={Boolean(notice)}/>}
      <div key={title} className='viewer-notice-body' data-swap={title !== first || undefined}>
        <h2>{title}</h2>
        {text && <p>{text}</p>}
        {action && <button type='button' className='viewer-action' disabled={!online} onClick={onAction}>{action}</button>}
      </div>
    </div>
  )
}

// [DOC: selection-gestures]
export default memo(function Viewer({job, notice, selection, dispatch, readOnly}) {
  const refs = useRef({video: null, draw: null, drag: null})
  const viewer = useRef(null)
  const waiting = usePlayer(state => state.waiting)
  const loaded = usePlayer(state => state.loaded)
  const failed = usePlayer(state => state.failed)
  const {time, points, box} = selection
  const {lift, ask, cycle} = useLift(job, dispatch, readOnly)
  const aspect = job ? job.meta.width / job.meta.height : null
  useFit(viewer, aspect)

  useEffect(() => job ? attach(refs.current.video) : undefined, [job])

  const select = patch => {haptic.tap(); dispatch(patch); ask({...selection, ...patch})}
  const frame = () => {
    const now = frameTime(frameOf(getTime()))
    return {now, same: time !== null && frameOf(time) === frameOf(now)}
  }

  const tap = ([x, y], rect) => {
    const {now, same} = frame()
    const mark = [x, y, 1]
    if (!same) return select({time: now, points: [mark], box: null})
    const hit = points.findIndex(([px, py]) => Math.hypot((px - x) * rect.width, (py - y) * rect.height) < HIT)
    if (hit < 0) return select({points: [...points, mark]})
    if (cycle()) return haptic.tap()
    const rest = points.filter((_, i) => i !== hit)
    select({points: rest, time: rest.length || box ? time : null})
  }

  const drawBox = value => {
    const {now, same} = frame()
    select(same ? {box: value} : {time: now, box: value, points: []})
  }

  const hide = () => {refs.current.drag = null; refs.current.draw.hidden = true}

  const down = event => {
    if (readOnly || !job || !event.isPrimary || event.button > 0) return
    hold()
    event.currentTarget.setPointerCapture(event.pointerId)
    refs.current.drag = {rect: event.currentTarget.getBoundingClientRect(), x: event.clientX, y: event.clientY, box: null}
  }

  const move = event => {
    const {drag, draw} = refs.current
    if (!drag || (!drag.box && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < TAP)) return
    const [x0, y0] = norm(drag.x, drag.y, drag.rect)
    const [x1, y1] = norm(event.clientX, event.clientY, drag.rect)
    drag.box = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]
    Object.assign(draw.style, boxStyle(drag.box))
    draw.hidden = false
  }

  const up = event => {
    const {drag} = refs.current
    hide()
    if (!drag) return
    if (!drag.box) return tap(norm(event.clientX, event.clientY, drag.rect), drag.rect)
    const [x0, y0, x1, y1] = drag.box
    if ((x1 - x0) * drag.rect.width >= MIN_BOX && (y1 - y0) * drag.rect.height >= MIN_BOX) drawBox(drag.box)
  }

  return (
    <section ref={viewer} className='viewer enter' aria-label='Video' data-fit={aspect ? '' : undefined} style={{'--aspect': aspect ?? FALLBACK_ASPECT}}>
      <div className='viewer-stage' data-loaded={loaded || undefined}>
        <Sheen on={Boolean(job) && !loaded && !failed}/>
        {/* [DOC: video-source] */}
        {job && <video ref={el => {refs.current.video = el}} className='viewer-video' src={`${job.proxy_url}#t=0.001`} playsInline preload='auto' disablePictureInPicture/>}
        {job && <Lift lift={lift} refs={refs} origin={originOf(points, box)}/>}
        {job && <Marks time={time} points={points} box={box} pending={lift?.pending}/>}
        <div ref={el => {refs.current.draw = el}} className='viewer-box' data-draft hidden/>
        <div className='viewer-input' data-off={readOnly || !job || undefined} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={hide}/>
      </div>
      {job && <span className='spinner viewer-spinner' data-on={(waiting && loaded) || undefined} aria-hidden='true'/>}
      <Notice notice={notice ?? (failed ? BROKEN : null)}/>
    </section>
  )
})
