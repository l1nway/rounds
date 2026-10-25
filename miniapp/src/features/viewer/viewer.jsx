import {memo, useEffect, useRef} from 'react'
import Icon from '../../components/icon.jsx'
import {attach, clamp, formatTime, frameOf, frameTime, getTime, hold, seek, usePlayer} from '../../hooks/player.js'
import {useOnline} from '../../hooks/state.js'
import {haptic} from '../../services/telegram.js'
import './viewer.css'

const TAP = 8
const HIT = 24
const MIN_BOX = 12
const FALLBACK_ASPECT = 16 / 9
const BROKEN = {title: 'The video did not load', text: 'Check the connection and open the editor again.'}
const HINT = 'Drag a box around the object or tap it'
const HINT_EXCLUDE = 'Tap what to leave out'
const HINT_LONE = 'a box picks the whole object'
const CLEAR = {time: null, points: [], box: null}
const PLURAL = new Intl.PluralRules('en')

const round = value => Math.round(value * 1e4) / 1e4
const norm = (x, y, rect) => [round(clamp((x - rect.left) / rect.width, 0, 1)), round(clamp((y - rect.top) / rect.height, 0, 1))]
const pct = value => `${value * 100}%`
const boxStyle = ([x0, y0, x1, y1]) => ({left: pct(x0), top: pct(y0), width: pct(x1 - x0), height: pct(y1 - y0)})
const count = (n, one, many) => n ? `${n} ${PLURAL.select(n) === 'one' ? one : many}` : ''
const summary = (points, box) => [
  count(points.filter(([, , label]) => label).length, 'point', 'points'),
  count(points.filter(([, , label]) => !label).length, 'exclusion', 'exclusions'),
  box ? 'box' : '',
  !box && points.length === 1 ? HINT_LONE : ''
].filter(Boolean).join(' · ')
const useAway = time => usePlayer(state => time !== null && frameOf(state.time) !== frameOf(time))

// [DOC: selection-frame]
export const SelectionBar = memo(function SelectionBar({draft: {time, points, box, negative}, dispatch, disabled}) {
  const away = useAway(time)
  const text = time === null ? negative ? HINT_EXCLUDE : HINT : summary(points, box)
  return (
    <div className='selection'>
      <button type='button' className='icon-button' aria-pressed={negative} disabled={disabled} onClick={() => dispatch(prev => ({negative: !prev.negative}))}>
        <Icon name='exclude'/>Not this
      </button>
      {away
        ? <button type='button' className='selection-chip' onClick={() => seek(time)}>Selection at {formatTime(time)} · Jump</button>
        : <p className='selection-text'>{text}</p>}
      <button type='button' className='icon-button' aria-label='Clear selection' disabled={disabled || time === null} onClick={() => dispatch(CLEAR)}>
        <Icon name='clear'/>
      </button>
    </div>
  )
})

const Marks = memo(function Marks({time, points, box}) {
  const away = useAway(time)
  return (
    <div className='viewer-marks' data-away={away || undefined} aria-hidden='true'>
      {box && <div className='viewer-box' style={boxStyle(box)}/>}
      {points.map(([x, y, label]) => <i key={`${x}:${y}`} className='viewer-point' data-negative={!label || undefined} style={{left: pct(x), top: pct(y)}}/>)}
    </div>
  )
})

function Notice({notice: {title, text, busy, action, onAction}}) {
  const online = useOnline()
  return (
    <div className='viewer-notice' role='status'>
      {busy && <span className='spinner' aria-hidden='true'/>}
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      {action && <button type='button' className='viewer-action' disabled={!online} onClick={onAction}>{action}</button>}
    </div>
  )
}

// [DOC: selection-gestures]
export default function Viewer({job, notice, draft, dispatch, readOnly}) {
  const refs = useRef({video: null, draw: null, drag: null})
  const waiting = usePlayer(state => state.waiting)
  const failed = usePlayer(state => state.failed)
  const {time, points, box, negative} = draft

  useEffect(() => job ? attach(refs.current.video) : undefined, [job])

  const select = patch => {haptic.tap(); dispatch(patch)}
  const frame = () => {
    const now = frameTime(frameOf(getTime()))
    return {now, same: time !== null && frameOf(time) === frameOf(now)}
  }

  const tap = ([x, y], rect) => {
    const {now, same} = frame()
    const mark = [x, y, negative ? 0 : 1]
    if (!same) return select({time: now, points: [mark], box: null})
    const hit = points.findIndex(([px, py]) => Math.hypot((px - x) * rect.width, (py - y) * rect.height) < HIT)
    if (hit < 0) return select({points: [...points, mark]})
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
    <section className='viewer' aria-label='Video'>
      <div className='viewer-stage' style={{'--aspect': job ? job.meta.width / job.meta.height : FALLBACK_ASPECT}}>
        {job && <video ref={el => {refs.current.video = el}} className='viewer-video' src={job.proxy_url} playsInline preload='auto' disablePictureInPicture/>}
        {job && <Marks time={time} points={points} box={box}/>}
        <div ref={el => {refs.current.draw = el}} className='viewer-box' data-draft hidden/>
        <div className='viewer-input' data-off={readOnly || !job || undefined} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={hide}/>
      </div>
      {job && <span className='spinner viewer-spinner' data-on={waiting || undefined} aria-hidden='true'/>}
      {(notice || failed) && <Notice notice={notice ?? BROKEN}/>}
    </section>
  )
}
