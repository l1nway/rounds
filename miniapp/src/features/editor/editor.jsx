import {memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState} from 'react'
import {MIN_RANGE, clamp, ms, seek, setRange} from '../../hooks/player.js'
import {merge, useOnline} from '../../hooks/state.js'
import {postRender} from '../../services/api.js'
import {close, haptic, useMainButton} from '../../services/telegram.js'
import Timeline from '../timeline/timeline.jsx'
import Viewer from '../viewer/viewer.jsx'
import './editor.css'

const NOTES = {
  rendering: 'Already submitted. Progress comes in the chat.',
  done: 'Already made. Edit and make another one.',
  failed: 'The last render failed. Adjust and retry.'
}
const OFFLINE = 'Offline: editing works, sending waits.'
// [DOC: options-seam]
const OPTIONS = [
  {key: 'loudnorm', label: 'Normalize loudness', hint: 'Evens out quiet and loud parts', needs: meta => meta.has_audio, missing: 'This video has no sound'},
  {key: 'interpolate', label: 'Smooth to 60 fps', hint: 'AI draws in-between frames, fixes stutter', needs: meta => meta.interpolable, missing: 'Already a steady 60 fps'},
  {key: 'metadata', label: 'Keep original metadata', hint: 'Date, camera, GPS: recipients see where it was filmed', needs: meta => Object.keys(meta.tags ?? {}).length > 0, missing: 'This video has no metadata'}
]
const DEFAULT_OPTIONS = Object.fromEntries(OPTIONS.map(({key}) => [key, false]))
const TRAVEL = 13
const SLOP = 4

const optionsFor = (meta, options) => Object.fromEntries(OPTIONS.map(({key, needs}) => [key, needs(meta) && Boolean(options[key])]))

const init = job => {
  const last = job?.request
  return {
    start: last?.start ?? 0, end: last?.end ?? ms(Math.min(job?.meta.duration ?? 0, job?.max_duration ?? 0)),
    time: last?.prompt.time ?? null, points: last?.prompt.points ?? [], box: last?.prompt.box ?? null,
    mask: last?.prompt.mask ?? null, options: {...DEFAULT_OPTIONS, ...last?.options}, posting: false, error: null
  }
}

const isValid = ({start, end, time, points, box}, job) => Boolean(job) && (Boolean(box) || points.some(p => p[2] === 1))
  && end - start >= Math.min(MIN_RANGE, job.meta.duration) && end - start <= job.max_duration + 1e-6
  && time !== null && time >= start && time <= end

// [DOC: switch]
function Switch({name, label, text, checked, disabled, onSet}) {
  const gesture = useRef(null)
  const [first] = useState(text)

  const down = event => {
    const input = event.currentTarget.control
    const own = event.target === input && !input.matches(':disabled') && event.isPrimary && event.button < 1
    gesture.current = own ? {id: event.pointerId, x0: event.clientX, from: input.checked ? TRAVEL : 0, x: 0} : null
    if (own) input.dataset.press = ''
  }

  const move = event => {
    const g = gesture.current
    if (!g || g.done) return
    const dx = event.clientX - g.x0
    if (!g.moved && Math.abs(dx) < SLOP) return
    const input = event.currentTarget.control
    if (!g.moved) {g.moved = true; event.currentTarget.setPointerCapture(g.id); input.dataset.drag = ''}
    g.x = clamp(g.from + dx, 0, TRAVEL)
    input.style.setProperty('--x', `${g.x}px`)
  }

  const end = event => {
    const g = gesture.current
    if (!g || g.done) return
    const input = event.currentTarget.control
    delete input.dataset.press
    delete input.dataset.drag
    input.style.removeProperty('--x')
    g.done = true
    if (!g.moved || event.type !== 'pointerup') gesture.current = null
    else onSet(name, g.x > TRAVEL / 2)
  }

  const click = event => {
    if (!gesture.current?.moved || !event.detail) return
    event.preventDefault()
    gesture.current = null
  }

  return (
    <label className='options-row' onPointerDown={down} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onClickCapture={click}>
      <span className='options-text'>
        {label}
        <small key={text} data-swap={text !== first || undefined}>{text}</small>
      </span>
      <input type='checkbox' role='switch' name={name} checked={checked} disabled={disabled} onChange={event => onSet(name, event.target.checked)}/>
    </label>
  )
}

const Options = memo(function Options({meta, options, dispatch, disabled}) {
  const set = (name, value) => dispatch(prev => ({options: {...prev.options, [name]: value}}))
  return (
    <fieldset className='options enter' disabled={disabled}>
      <legend className='visually-hidden'>Options</legend>
      {OPTIONS.map(({key, label, hint, needs, missing}) => {
        const off = Boolean(meta) && !needs(meta)
        return <Switch key={key} name={key} label={label} text={off ? missing : hint} checked={!off && Boolean(options[key])} disabled={off} onSet={set}/>
      })}
    </fieldset>
  )
})

// [DOC: editor-draft]
export default memo(function Editor({job, notice}) {
  const online = useOnline()
  const [draft, dispatch] = useReducer(merge, job, init)
  const {start, end, time, points, box, mask, options, posting, error} = draft
  // [DOC: render-boundaries]
  const selection = useMemo(() => ({time, points, box}), [time, points, box])
  const readOnly = job?.status === 'rendering'
  const valid = isValid(draft, job)

  useEffect(() => {setRange(start, end)}, [start, end])
  useLayoutEffect(() => {
    if (!job) return
    dispatch(init(job))
    seek(job.request?.prompt.time ?? job.request?.start ?? 0)
  }, [job])

  const submit = async () => {
    if (!valid || posting || !online || readOnly) return
    dispatch({posting: true, error: null})
    try {
      await postRender(job.id, {start, end, prompt: {time, points, box, mask}, options: optionsFor(job.meta, options)})
      haptic.notify('success')
      close()
    } catch (failure) {
      haptic.notify('error')
      dispatch({posting: false, error: failure.message})
    }
  }

  useMainButton({text: 'Make round', visible: !readOnly, active: valid && online, progress: posting, onClick: submit})

  const note = error ? '' : !online ? OFFLINE : NOTES[job?.status] ?? ''
  return (
    <main className='editor' aria-busy={!job || undefined}>
      <h1 className='visually-hidden'>Round editor</h1>
      <Viewer job={job} notice={notice} selection={selection} dispatch={dispatch} readOnly={readOnly}/>
      <Timeline job={job} start={start} end={end} time={time} dispatch={dispatch} readOnly={readOnly}/>
      <Options meta={job?.meta} options={options} dispatch={dispatch} disabled={!job || readOnly}/>
      <div className='editor-status enter'>
        <p role='alert'><span key={error}>{error}</span></p>
        <p role='status'><span key={note}>{note}</span></p>
      </div>
    </main>
  )
})
