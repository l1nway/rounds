import {useEffect} from 'react'
import Swap from '../../components/swap.jsx'
import {usePresence} from '../../hooks/state.js'
import {progress} from './follow.js'
import {boxStyle, pct} from './gestures.js'
import './tag.css'

const percent = new Intl.NumberFormat(undefined, {style: 'percent'})
const FLIP = 0.78
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
  const place = box ? boxStyle(box) : {left: pct(at[0]), top: pct(at[1])}
  return mounted && (
    <span ref={ref} className={box ? 'viewer-scan' : 'viewer-ring'} data-spin={share == null || undefined} style={{...place, '--share': share ?? 0}}/>
  )
}

// [DOC: ai-progress]
export default function Tag({anchor, box, asking, phase, offer, crop, onFollow, onCrop, onAsk, onStop}) {
  const busy = progress.use(state => state.follow ?? state.lift)
  const mode = modeOf(busy, {asking, phase, offer: offer || Boolean(box), crop})
  const [mounted, ref] = usePresence(Boolean(mode))
  const share = busy?.share

  // [DOC: follow-confirm]
  useEffect(() => {
    if (mode !== 'ask') return
    const away = event => {if (event.type === 'scroll' || !ref.current?.contains(event.target)) onAsk(false)}
    const events = ['pointerdown', 'scroll']
    events.forEach(type => addEventListener(type, away, true))
    return () => events.forEach(type => removeEventListener(type, away, true))
  }, [mode, onAsk, ref])

  // [DOC: crop-mode]
  const cropper = box && <button type='button' data-quiet={offer || undefined} onClick={onCrop}>{offer ? 'Just crop to it' : 'Crop to this area'}</button>
  const body = key => {
    if (key.startsWith(BUSY)) return <span>{key.slice(BUSY.length)}{share != null && <b>{percent.format(share)}</b>}</span>
    if (key === 'ask') return <>{crop ? 'Stop cropping?' : 'Stop following?'}<button type='button' data-danger onClick={onStop}>Stop</button></>
    if (key === 'failed') return <>Could not follow it<button type='button' onClick={onFollow}>Try again</button></>
    return <>{offer && <button type='button' onClick={onFollow}>{box ? 'Follow this area' : 'Follow this object'}</button>}{cropper}</>
  }

  return <>
    <Ring on={Boolean(busy)} at={anchor} box={box} share={share}/>
    {mounted && (
      <div ref={ref} className='viewer-tag' data-above={anchor[1] > FLIP || undefined}
        style={{left: pct(anchor[0]), top: pct(anchor[1])}} onPointerDown={stop}>
        <Swap as='div' item='div' className='viewer-tag-body' text={mode} resize>{body}</Swap>
      </div>
    )}
  </>
}
