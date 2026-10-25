import {memo, useEffect, useMemo, useReducer} from 'react'
import {MIN_RANGE, ms, seek, setRange} from '../../hooks/player.js'
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
  {key: 'interpolate', label: 'Smooth to 60 fps', hint: 'AI draws in-between frames, fixes stutter', needs: meta => meta.interpolable, missing: 'Already a steady 60 fps'}
]
const DEFAULT_OPTIONS = Object.fromEntries(OPTIONS.map(({key}) => [key, false]))

const optionsFor = (meta, options) => Object.fromEntries(OPTIONS.map(({key, needs}) => [key, needs(meta) && Boolean(options[key])]))

const init = job => {
  const last = job?.request
  return {
    start: last?.start ?? 0, end: last?.end ?? ms(Math.min(job?.meta.duration ?? 0, job?.max_duration ?? 0)),
    time: last?.prompt.time ?? null, points: last?.prompt.points ?? [], box: last?.prompt.box ?? null,
    options: {...DEFAULT_OPTIONS, ...last?.options}, posting: false, error: null
  }
}

const isValid = ({start, end, time, points, box}, job) => Boolean(job) && (Boolean(box) || points.some(p => p[2] === 1))
  && end - start >= Math.min(MIN_RANGE, job.meta.duration) && end - start <= job.max_duration + 1e-6
  && time !== null && time >= start && time <= end

const Options = memo(function Options({meta, options, dispatch, disabled}) {
  const change = event => {
    const {name, checked} = event.target
    dispatch(prev => ({options: {...prev.options, [name]: checked}}))
  }
  return (
    <fieldset className='options' disabled={disabled}>
      <legend className='visually-hidden'>Options</legend>
      {OPTIONS.map(({key, label, hint, needs, missing}) => {
        const off = Boolean(meta) && !needs(meta)
        return (
          <label key={key} className='options-row'>
            <span className='options-text'>
              {label}
              <small>{off ? missing : hint}</small>
            </span>
            <input type='checkbox' role='switch' name={key} checked={!off && Boolean(options[key])} disabled={off} onChange={change}/>
          </label>
        )
      })}
    </fieldset>
  )
})

// [DOC: editor-draft]
export default memo(function Editor({job, notice}) {
  const online = useOnline()
  const [draft, dispatch] = useReducer(merge, job, init)
  const {start, end, time, points, box, options, posting, error} = draft
  // [DOC: render-boundaries]
  const selection = useMemo(() => ({time, points, box}), [time, points, box])
  const readOnly = job?.status === 'rendering'
  const valid = isValid(draft, job)

  useEffect(() => {setRange(start, end)}, [start, end])
  useEffect(() => {if (job) seek(job.request?.prompt.time ?? job.request?.start ?? 0)}, [job])

  const submit = async () => {
    if (!valid || posting || !online || readOnly) return
    dispatch({posting: true, error: null})
    try {
      await postRender(job.id, {start, end, prompt: {time, points, box}, options: optionsFor(job.meta, options)})
      haptic.notify('success')
      close()
    } catch (failure) {
      haptic.notify('error')
      dispatch({posting: false, error: failure.message})
    }
  }

  useMainButton({text: 'Make round', visible: !readOnly, active: valid && online, progress: posting, onClick: submit})

  const note = !online ? OFFLINE : NOTES[job?.status] ?? ''
  return (
    <main className='editor' aria-busy={!job || undefined}>
      <h1 className='visually-hidden'>Round editor</h1>
      <Viewer job={job} notice={notice} selection={selection} dispatch={dispatch} readOnly={readOnly}/>
      <Timeline job={job} start={start} end={end} time={time} dispatch={dispatch} readOnly={readOnly}/>
      <Options meta={job?.meta} options={options} dispatch={dispatch} disabled={!job || readOnly}/>
      <div className='editor-status'>
        <p role='alert'>{error}</p>
        <p role='status'>{error ? '' : note}</p>
      </div>
    </main>
  )
})
