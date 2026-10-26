import {memo, useLayoutEffect, useRef, useState} from 'react'
import {useAway, usePlayer} from '../../hooks/player.js'
import './lift.css'

function Layer({mask, refs, away, sweep, leaving}) {
  const canvas = useRef(null)
  const loaded = usePlayer(state => state.loaded)

  useLayoutEffect(() => {
    const video = refs.current.video
    if (away || !loaded || !video) return
    const paint = () => {
      const c = canvas.current
      if (!c) return
      c.width = video.videoWidth
      c.height = video.videoHeight
      c.getContext('2d').drawImage(video, 0, 0)
    }
    if (!video.seeking) {paint(); return}
    video.addEventListener('seeked', paint, {once: true})
    return () => video.removeEventListener('seeked', paint)
  }, [away, loaded, refs])

  return (
    <div className='lift-layer' data-leaving={leaving || undefined} data-sweep={sweep} style={{'--m': `url("${mask}")`}}>
      <div className='lift-dim'/>
      <div className='lift-pop'>
        <div className='lift-glow'><canvas ref={canvas} className='lift-mask'/></div>
        <div className='lift-mask lift-shine'><i/></div>
      </div>
    </div>
  )
}

// [DOC: lift-look]
export default memo(function Lift({lift, refs, origin}) {
  const away = useAway(lift?.time ?? null)
  const mask = lift?.candidates[lift.index]?.mask ?? null
  const [layers, setLayers] = useState({cur: null, prev: null, n: 0})
  if (mask !== (layers.cur?.mask ?? null)) setLayers({cur: mask && {mask, n: layers.n + 1}, prev: layers.cur, n: layers.n + 1})
  const {cur, prev} = layers
  const [ox, oy] = origin ?? [0.5, 0.5]

  return (
    <div className='lift' data-away={away || undefined} data-stale={lift?.pending || undefined} style={{'--ox': `${ox * 100}%`, '--oy': `${oy * 100}%`}} aria-hidden='true'>
      {prev && <Layer key={prev.n} mask={prev.mask} refs={refs} away={away} leaving/>}
      {cur && <Layer key={cur.n} mask={cur.mask} refs={refs} away={away} sweep={prev ? '1' : '2'}/>}
    </div>
  )
})
