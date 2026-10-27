import {memo, useLayoutEffect, useRef, useState} from 'react'
import {STAGE_EVENTS} from '../../constants/look.js'
import {useAway} from '../../hooks/player.js'
import {useLeave, usePresence} from '../../hooks/state.js'
import './lift.css'

function Layer({n, mask, sweep, on, refs, done}) {
  const canvas = useRef(null)
  const [gone] = useState(() => () => done.gone(n))
  const ref = useLeave(on, gone)

  useLayoutEffect(() => {
    const {video, stage} = refs.current
    const paint = source => {
      const c = canvas.current
      if (c.width !== video.videoWidth || c.height !== video.videoHeight) Object.assign(c, {width: video.videoWidth, height: video.videoHeight})
      c.getContext('2d').drawImage(source ?? video, 0, 0, c.width, c.height)
    }
    // [DOC: lift-source]
    const fresh = () => {paint(); stage.dispatchEvent(new Event(STAGE_EVENTS.ask))}
    const graded = event => paint(event.detail)
    stage.addEventListener(STAGE_EVENTS.paint, graded)
    if (video.seeking) video.addEventListener('seeked', fresh, {once: true})
    else fresh()
    return () => {stage.removeEventListener(STAGE_EVENTS.paint, graded); video.removeEventListener('seeked', fresh)}
  }, [refs])

  return (
    <div ref={ref} className='lift-layer' data-sweep={sweep} style={{'--m': `url("${mask}")`}}>
      <div className='lift-dim'/>
      <div className='lift-pop'>
        <div className='lift-glow'><canvas ref={canvas} className='lift-mask'/></div>
        <div className='lift-mask lift-shine' onAnimationEnd={() => done.swept(n)}/>
      </div>
    </div>
  )
}

// [DOC: lift-look]
export default memo(function Lift({lift, refs, origin}) {
  const away = useAway(lift?.time ?? null)
  const mask = lift?.candidates[lift.index]?.mask ?? null
  const [layers, setLayers] = useState({cur: null, prev: null, n: 0})
  const [done] = useState(() => ({
    gone: n => setLayers(l => l.prev?.n === n ? {...l, prev: null} : l),
    swept: n => setLayers(l => l.cur?.n === n ? {...l, cur: {...l.cur, sweep: undefined}} : l)
  }))
  if (mask !== (layers.cur?.mask ?? null)) {
    const n = layers.n + 1
    setLayers({cur: mask && {mask, n, sweep: layers.cur ? '1' : '2'}, prev: layers.cur, n})
  }
  const {cur, prev} = layers
  const [mounted, ref] = usePresence(Boolean(cur || prev) && !away)
  if (!mounted && prev) setLayers({...layers, prev: null})
  if (!mounted) return null
  const [ox, oy] = origin ?? [0.5, 0.5]

  return (
    <div ref={ref} className='lift' data-away={away || undefined} data-stale={lift?.pending || undefined} style={{'--ox': `${ox * 100}%`, '--oy': `${oy * 100}%`}} aria-hidden='true'>
      {prev && <Layer key={prev.n} {...prev} refs={refs} done={done}/>}
      {cur && <Layer key={cur.n} {...cur} refs={refs} done={done} on/>}
    </div>
  )
})
