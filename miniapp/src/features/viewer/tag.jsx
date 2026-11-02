import {useEffect, useState} from 'react'
import Swap from '../../components/swap.jsx'
import {usePlayer} from '../../hooks/player.js'
import {usePresence} from '../../hooks/state.js'
import {progress} from './follow.js'
import {boxStyle, pct} from './gestures.js'
import './tag.css'

const percent = new Intl.NumberFormat(undefined, {style: 'percent'})
const FLIP = 0.78
const ROOM = 0.2
const MEMO = 'Video unloaded: not enough memory on this device'
const BUSY = 'busy:'
const stop = event => event.stopPropagation()

const modeOf = (busy, {asking, phase, offer, crop}) => {
  if (busy) return BUSY + busy.label
  if (asking) return 'ask'
  if (crop) return null
  if (phase === 'failed') return 'failed'
  return offer && !phase ? 'offer' : null
}

// [DOC: box-scan]
function Ring({on, at, box, share}) {
  const [mounted, ref] = usePresence(on)
  // [DOC: ring-exit]
  const [held, setHeld] = useState(share)
  if (on && share !== held) setHeld(share)
  const [comet, cometRef] = usePresence(on && held == null)
  const place = box ? boxStyle(box) : {left: pct(at[0]), top: pct(at[1])}
  return mounted && (
    <span ref={ref} className={box ? 'viewer-scan' : 'viewer-ring'} data-spin={held == null || undefined} style={{...place, '--share': held ?? 0}}>
      {comet && <i ref={cometRef}/>}
    </span>
  )
}

// [DOC: park-memo]
function Memo({at, flip}) {
  const parked = usePlayer(state => state.parked)
  const [mounted, ref] = usePresence(parked)
  const side = flip ? 'below' : at[1] < ROOM ? 'under' : undefined
  return mounted && <p ref={ref} className='viewer-memo' role='status' data-side={side} style={{left: pct(at[0]), top: pct(at[1])}}>{MEMO}</p>
}

// [DOC: ai-progress]
export default function Tag({anchor, box, asking, phase, offer, crop, onFollow, onCrop, onAsk, onStop}) {
  const busy = progress.use(state => state.follow ?? state.lift)
  const mode = modeOf(busy, {asking, phase, offer: offer || Boolean(box), crop})
  const [mounted, ref] = usePresence(Boolean(mode))
  const share = busy?.share
  const above = anchor[1] > FLIP
  // [DOC: tag-morph]
  const now = {share, offer, box, lone: !(offer && box) || undefined}
  const [seen, setSeen] = useState({})
  if (mode && Object.keys(now).some(key => seen[mode]?.[key] !== now[key])) setSeen({...seen, [mode]: now})
  const [last, setLast] = useState(mode)
  if (mode && mode !== last) setLast(mode)
  const shown = mode ?? last
  const solid = shown === 'offer' && Boolean((seen.offer ?? now).lone)

  // [DOC: follow-confirm]
  useEffect(() => {
    if (mode !== 'ask') return
    const away = event => {if (event.type === 'scroll' || !ref.current?.contains(event.target)) onAsk(false)}
    const events = ['pointerdown', 'scroll']
    events.forEach(type => addEventListener(type, away, true))
    return () => events.forEach(type => removeEventListener(type, away, true))
  }, [mode, onAsk, ref])

  const body = key => {
    const {share, offer, box, lone} = seen[key] ?? now
    if (key.startsWith(BUSY)) return <span>{key.slice(BUSY.length)}{share != null && <b>{percent.format(share)}</b>}</span>
    if (key === 'ask') return <>{crop ? 'Stop cropping?' : 'Stop following?'}<button type='button' data-danger onClick={onStop}>Stop</button></>
    if (key === 'failed') return <>Could not follow it<button type='button' onClick={onFollow}>Try again</button></>
    // [DOC: crop-mode]
    const cropper = box && <button type='button' data-quiet={offer || undefined} data-lone={lone} onClick={onCrop}>{offer ? 'Just crop to it' : 'Crop to this area'}</button>
    return <>{offer && <button type='button' data-lone={lone} onClick={onFollow}>{box ? 'Follow this area' : 'Follow this object'}</button>}{cropper}</>
  }

  return <>
    <Ring on={Boolean(busy)} at={anchor} box={box} share={share}/>
    <Memo at={anchor} flip={above}/>
    {mounted && (
      <div ref={ref} className='viewer-tag' data-above={above || undefined} data-solid={solid || undefined}
        style={{left: pct(anchor[0]), top: pct(anchor[1])}} onPointerDown={stop}>
        <Swap as='div' item='div' className='viewer-tag-body' text={shown} resize>{body}</Swap>
      </div>
    )}
  </>
}
