import {memo, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react'
import Icon from '../../components/icon.jsx'
import Sheen from '../../components/sheen.jsx'
import {MIN_RANGE, clamp, formatTime, frameOf, frameTime, getTime, ms, seek, step, toggle, usePlayer} from '../../hooks/player.js'
import {haptic} from '../../services/telegram.js'
import useDrag from './use-drag.js'
import './timeline.css'

const STRIP = 48
const MODES = ['Hold still to refine', 'Fine', 'Finest']
const HANDLES = [['start', 'Trim start'], ['end', 'Trim end']]
const KEYS = {ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1}
const seconds = t => `${+t.toFixed(3)} s`
const stepLabel = s => s >= 0.1 ? `${seconds(s)}/px` : `${+(s * 1000).toFixed(s < 0.01 ? 2 : 1)} ms/px`
const modeLabel = mode => mode && (mode.level ? `${MODES[mode.level]} · ${stepLabel(mode.step)}` : MODES[0])

const Filmstrip = memo(function Filmstrip({url, tiles, tileWidth, tileHeight}) {
  const ref = useRef(null)
  const [width, setWidth] = useState(0)
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!url) return
    let live = true
    const image = new Image()
    image.src = url
    image.decode().catch(() => {}).then(() => live && setReady(true))
    return () => {live = false}
  }, [url])

  // [DOC: filmstrip-cells]
  const cells = useMemo(() => {
    if (!ready || !width || !tiles) return []
    const scale = Math.max(STRIP / tileWidth, STRIP / tileHeight)
    const [w, h] = [tileWidth * scale, tileHeight * scale]
    return Array.from({length: Math.ceil(width / STRIP)}, (_, i) => {
      const tile = Math.min(tiles - 1, Math.floor((i + 0.5) * STRIP / width * tiles))
      return {backgroundSize: `${tiles * w}px ${h}px`, backgroundPosition: `${-(tile * w + (w - STRIP) / 2)}px ${-(h - STRIP) / 2}px`}
    })
  }, [ready, width, tiles, tileWidth, tileHeight])

  return (
    <div ref={ref} className='timeline-film' data-ready={ready || undefined} style={{'--film': url ? `url(${JSON.stringify(url)})` : 'none'}} aria-hidden='true'>
      <Sheen on={!ready}/>
      {cells.map((style, i) => <i key={i} style={style}/>)}
    </div>
  )
})

const Clock = memo(function Clock({mode}) {
  const time = usePlayer(state => state.time)
  return (
    <div className='timeline-clock'>
      <output aria-label='Current time'>{formatTime(time)}</output>
      <span className='timeline-mode' data-on={mode ? '' : undefined} aria-live='polite'>{modeLabel(mode)}</span>
    </div>
  )
})

// [DOC: timeline-hit-areas]
const Scrub = memo(function Scrub({duration, start, end}) {
  const time = usePlayer(state => state.time)
  return (
    <div className='timeline-scrub' data-scrub role='slider' tabIndex={0} aria-label='Playhead' aria-valuemin={start} aria-valuemax={end}
      aria-valuenow={ms(time)} aria-valuetext={formatTime(time)}>
      <i className='timeline-playhead' style={{left: `${time / duration * 100}%`}}/>
    </div>
  )
})

const tick = dir => {step(dir); haptic.tick()}

const Controls = memo(function Controls({disabled, length}) {
  const paused = usePlayer(state => state.paused)
  return (
    <div className='timeline-controls'>
      <span/>
      <div className='timeline-buttons'>
        <button type='button' className='icon-button' aria-label='Previous frame' disabled={disabled} onClick={() => tick(-1)}><Icon name='previous'/></button>
        <button type='button' className='icon-button' aria-label={paused ? 'Play' : 'Pause'} disabled={disabled} onClick={toggle}><Icon key={paused} name={paused ? 'play' : 'pause'}/></button>
        <button type='button' className='icon-button' aria-label='Next frame' disabled={disabled} onClick={() => tick(1)}><Icon name='next'/></button>
      </div>
      <span className='timeline-length'>{length}</span>
    </div>
  )
})

// [DOC: trim-bounds]
export default memo(function Timeline({job, start, end, time, dispatch, readOnly}) {
  const [mode, setMode] = useState(null)
  const api = useRef(null)
  const drag = useDrag(api, setMode)
  const duration = job?.meta.duration ?? 0
  const max = job?.max_duration ?? 0
  const min = Math.min(MIN_RANGE, duration)
  const pct = t => `${t / duration * 100}%`

  const bounds = kind => kind === 'start' ? [Math.max(0, end - max), Math.min(end - min, time ?? Infinity)]
    : kind === 'end' ? [Math.max(start + min, time ?? -Infinity), Math.min(duration, start + max)] : [start, end]
  const read = kind => kind === 'play' ? getTime() : kind === 'start' ? start : end
  const write = (kind, raw) => {
    const value = clamp(raw, ...bounds(kind))
    if (kind !== 'play') dispatch({[kind]: ms(value)})
    seek(ms(value))
    return value
  }
  useLayoutEffect(() => {api.current = {duration, read, write}})

  const key = event => {
    const kind = event.target.dataset.kind || ('scrub' in event.target.dataset ? 'play' : '')
    const dir = KEYS[event.key]
    if (!kind || !dir) return
    event.preventDefault()
    const value = read(kind)
    write(kind, event.shiftKey ? value + dir : frameTime(frameOf(value) + dir))
  }

  const film = job?.filmstrip ?? {}
  return (
    <section className='timeline' aria-label='Trim' data-empty={!job || undefined} style={{'--strip': `${STRIP}px`}}>
      <div className='timeline-head'>
        <span>{formatTime(start)}</span>
        <Clock mode={mode}/>
        <span>{formatTime(end)}</span>
      </div>
      <div className='timeline-track' onKeyDown={key} {...(job ? drag : {})}>
        <Filmstrip url={job?.filmstrip_url} tiles={film.tiles} tileWidth={film.tile_width} tileHeight={film.tile_height}/>
        {job && <>
          <i className='timeline-shade' data-side='start' style={{left: 0, width: pct(start)}}/>
          <i className='timeline-shade' data-side='end' style={{right: 0, width: pct(duration - end)}}/>
          {time !== null && <i className='timeline-mark' style={{left: pct(time)}}/>}
          <Scrub duration={duration} start={start} end={end}/>
          <div className='timeline-trim' data-off={readOnly || undefined} style={{left: pct(start), width: pct(end - start)}}>
            {!readOnly && HANDLES.map(([kind, label]) => (
              <div key={kind} className='timeline-handle' data-kind={kind} role='slider' tabIndex={0} aria-label={label} aria-valuemin={0}
                aria-valuemax={ms(duration)} aria-valuenow={kind === 'start' ? start : end} aria-valuetext={formatTime(kind === 'start' ? start : end)}/>
            ))}
          </div>
        </>}
      </div>
      <Controls disabled={!job} length={job ? `${seconds(end - start)} of ${seconds(max)}` : ''}/>
    </section>
  )
})
