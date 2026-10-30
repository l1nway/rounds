import {memo, useEffect, useLayoutEffect, useRef, useState} from 'react'
import Icon from '../../components/icon.jsx'
import Sheen from '../../components/sheen.jsx'
import Swap from '../../components/swap.jsx'
import {attach, useAway, usePlayer} from '../../hooks/player.js'
import {useOnline, usePresence} from '../../hooks/state.js'
import {haptic} from '../../services/telegram.js'
import {useFollow, useLift} from './follow.js'
import {boxStyle, pct, squared, useGestures} from './gestures.js'
import Lift from './lift.jsx'
import Tag from './tag.jsx'
import './viewer.css'

const CORNERS = ['tl', 'tr', 'bl', 'br']
// [DOC: viewer-fit]
const FIT = {duration: 600, easing: 'cubic-bezier(0.4, 0, 0.2, 1)'}
const BROKEN = {title: 'The video did not load', text: 'Check the connection and open the editor again.'}

const originOf = (points, box) => box ? [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] : points[0]
const anchorOf = (points, box) => box ? [(box[0] + box[2]) / 2, box[3]] : points.at(-1)
const same = (a, b) => a?.title === b?.title && a?.text === b?.text && a?.action === b?.action

// [DOC: viewer-fit]
function useFit(ref, aspect) {
  const last = useRef(aspect)
  useLayoutEffect(() => {
    const el = ref.current
    const prev = last.current
    last.current = aspect
    if (aspect === prev || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.style.setProperty('--aspect', prev)
    const from = el.offsetHeight
    el.style.setProperty('--aspect', aspect)
    el.animate({height: [`${from}px`, `${el.offsetHeight}px`], '--aspect': [prev, aspect]}, {...FIT, id: 'fit'})
  }, [ref, aspect])
}

// [DOC: look-preview]
let Look = null
function useLook(loaded, on) {
  const [ready, setReady] = useState(Boolean(Look))
  useEffect(() => {if (loaded && !ready) import('./look.jsx').then(module => {Look = module.default; setReady(true)}, () => {})}, [loaded, on, ready])
  return ready
}

// [DOC: selection-frame]
const Marks = memo(function Marks({time, points, box, crop, follow, tag}) {
  const away = useAway(time)
  return (
    <div ref={follow} className='viewer-marks' data-away={away || undefined}>
      {box && <div className='viewer-box' data-crop={crop || undefined} style={boxStyle(box)} aria-hidden='true'>{CORNERS.map(c => <i key={c} className='viewer-corner' data-corner={c}/>)}</div>}
      {points.map(([x, y, label]) => <i key={`${x}:${y}`} className='viewer-point' data-negative={!label || undefined} style={{left: pct(x), top: pct(y)}} aria-hidden='true'/>)}
      {tag}
    </div>
  )
})

// [DOC: loading-crossfade]
function Notice({notice}) {
  const online = useOnline()
  const [mounted, ref] = usePresence(Boolean(notice))
  const [shown, setShown] = useState(notice)
  const [still, setStill] = useState(mounted)
  if (notice && !same(notice, shown)) setShown(notice)
  if (still && !mounted) setStill(false)
  return mounted && (
    <div ref={ref} className='viewer-notice' role='status' data-busy={shown.busy || undefined} data-still={still || undefined}>
      <Sheen on={Boolean(shown.busy)}/>
      <Swap as='div' item='div' className='viewer-notice-body' text={shown}>
        {({title, text, action, onAction, local}) => <>
          <h2>{title}</h2>
          {text && <p>{text}</p>}
          {action && <button type='button' className='viewer-action' disabled={!online && !local}
            onClick={same(notice, {title, text, action}) ? notice.onAction : onAction}>{action}</button>}
        </>}
      </Swap>
    </div>
  )
}

// [DOC: compare]
const NO_HOVER = '(hover: none)'
function Compare({show, held, set}) {
  const was = useRef(false)
  const [mounted, button] = usePresence(show)
  const touch = () => matchMedia(NO_HOVER).matches
  // a tap elsewhere or a scroll ends the comparison: Safari does not blur a button for a tap on a plain area
  useEffect(() => {
    if (!held || !touch()) return
    const el = button.current
    const away = event => {if (event.type === 'scroll' || !el?.contains(event.target)) el?.blur()}
    const events = ['pointerdown', 'scroll']
    events.forEach(t => addEventListener(t, away, true))
    return () => events.forEach(t => removeEventListener(t, away, true))
  }, [held, button])
  const down = event => {
    const el = event.currentTarget
    if (touch()) {
      was.current = document.activeElement === el
      if (!was.current) el.focus()  // Safari does not focus a button on tap
      return
    }
    el.setPointerCapture(event.pointerId)
    set(true)
  }
  const release = () => {if (!touch()) set(false)}
  const key = value => event => {if ((event.key === ' ' || event.key === 'Enter') && !event.repeat && !touch()) set(value)}
  return mounted && (
    <button ref={button} type='button' className='viewer-compare' aria-label='Hold to see the original' aria-pressed={held}
      onPointerDown={down} onPointerUp={release} onPointerCancel={release} onKeyDown={key(true)} onKeyUp={key(false)}
      onFocus={() => {if (touch()) set(true)}} onBlur={() => set(false)}
      onClick={event => {if (touch() && was.current) event.currentTarget.blur(); was.current = false}}>
      <Icon name='compare'/>
    </button>
  )
}

export default memo(function Viewer({job, notice, aspect, selection, crop, start, end, look, exposure, adjusting, dispatch, readOnly}) {
  const refs = useRef({video: null, stage: null, draw: null, drag: null})
  const viewer = useRef(null)
  const [{stage, video, draw}] = useState(() => Object.fromEntries(['stage', 'video', 'draw'].map(key => [key, el => {refs.current[key] = el}])))  // [DOC: stable-refs]
  const waiting = usePlayer(state => state.waiting)
  const loaded = usePlayer(state => state.loaded)
  const failed = usePlayer(state => state.failed)
  const [revealed, setRevealed] = useState(false)
  const [shown, setShown] = useState(null)
  const source = job?.file ?? job?.id ?? null  // [DOC: loading-crossfade]
  if (source !== shown) {setShown(source); setRevealed(false)}
  const [pressed, setPressed] = useState(false)
  const [spinning, spinner] = usePresence(waiting && loaded)
  const {time, points, box} = selection
  const {lift, ask, cycle} = useLift(job, dispatch, readOnly)
  const followId = job?.follow ?? (job?.tier === 'free' ? null : job?.id)
  const {attach: follow, phase, confirm, stop} = useFollow(followId, selection, lift?.candidates[lift.index]?.mask ?? null, Boolean(lift?.pending), start, end)
  const graded = look > 0 || exposure !== 0
  const [bypass, setBypass] = useState(false)
  const held = bypass && graded  // [DOC: compare]
  if (bypass && !graded) setBypass(false)
  const lookReady = useLook(loaded, graded)
  const [asking, setAsking] = useState(false)
  const locked = phase === 'tracking' || phase === 'tracked' || crop  // [DOC: follow-confirm]
  if (asking && !locked) setAsking(false)
  const {down, move, up, hide} = useGestures({job, selection, dispatch, readOnly, refs, ask, cycle, locked, onMark: () => setAsking(true)})
  useFit(viewer, aspect)

  useEffect(() => job ? attach(refs.current.video) : undefined, [job])

  // [DOC: draft-box]
  const press = event => {down(event); if (refs.current.drag && !locked) setPressed(true)}
  const release = handler => event => {
    if (!refs.current.drag) return
    handler(event)
    setPressed(false)
  }

  const isBlob = Boolean(job?.proxy_url?.startsWith('blob:'))
  const src = job ? (isBlob ? job.proxy_url : `${job.proxy_url}#t=0.001`) : ''

  return (
    <section ref={viewer} className='viewer enter' aria-label='Video' style={{'--aspect': aspect}}>
      <div ref={stage} className='viewer-stage' data-reveal={(loaded && !revealed) || undefined} data-off={readOnly || !job || undefined}
        onPointerDown={press} onPointerMove={move} onPointerUp={release(up)} onPointerCancel={release(hide)}>
        <Sheen on={Boolean(job) && !loaded && !failed}/>
        {/* [DOC: video-source] */}
        {job && <video key={job.proxy_url} ref={video} className='viewer-video' src={src} crossOrigin={isBlob ? undefined : 'anonymous'} playsInline preload={isBlob ? 'metadata' : 'auto'}
          disablePictureInPicture onAnimationEnd={() => setRevealed(true)}/>}
        {loaded && graded && lookReady && (job.id || job.local) && <Look job={job} look={held ? 0 : look} exposure={held ? 0 : exposure} adjusting={adjusting} refs={refs} dispatch={dispatch}/>}
        {loaded && <Lift lift={lift} refs={refs} origin={originOf(points, box)}/>}
        {loaded && (points.length > 0 || box) && <Marks time={time} points={points} box={box} crop={crop} follow={follow}
          tag={!readOnly && <Tag anchor={anchorOf(points, box)} box={box} asking={asking} phase={phase} offer={Boolean(followId) && !lift?.pending}
            crop={crop} onFollow={confirm} onCrop={() => {haptic.tap(); dispatch({crop: true, box: squared(box, aspect)})}}
            onAsk={setAsking} onStop={() => {setAsking(false); if (crop) dispatch({crop: false}); else stop()}}/>}/>}
        {pressed && <div ref={draw} className='viewer-box' data-draft hidden/>}
      </div>
      {loaded && <Compare show={graded} held={held} set={setBypass}/>}
      {spinning && <span ref={spinner} className='spinner viewer-spinner' aria-hidden='true'/>}
      <Notice notice={notice ?? (failed ? BROKEN : null)}/>
    </section>
  )
})
