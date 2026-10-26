import {memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef} from 'react'
import Swap from '../../components/swap.jsx'
import {seek, setRange, usePlayer} from '../../hooks/player.js'
import {merge, useOnline} from '../../hooks/state.js'
import {launchAspect, postRender} from '../../services/api.js'
import {close, haptic} from '../../services/telegram.js'
import Timeline from '../timeline/timeline.jsx'
import Viewer from '../viewer/viewer.jsx'
import {init, isValid, optionsFor} from './draft.js'
import Options from './options.jsx'
import './editor.css'

const NOTES = {
  rendering: 'Already submitted. Progress comes in the chat.',
  done: 'Already made. Edit and make another one.',
  failed: 'The last render failed. Adjust and retry.'
}
const OFFLINE = 'Offline: editing works, sending waits.'
const FORM = 'round'
const FALLBACK_ASPECT = launchAspect() ?? 16 / 9
// [DOC: split-layout]
const SPLIT_BELOW = 1.7

// [DOC: submit-form]
const noEnter = event => {if (event.key === 'Enter') event.preventDefault()}

// [DOC: editor-draft]
export default memo(function Editor({job, notice}) {
  const online = useOnline()
  const loaded = usePlayer(state => state.loaded)
  const [draft, dispatch] = useReducer(merge, job, init)
  const form = useRef(null)
  const {start, end, time, points, box, mask, options, codec, denoise, posting, error} = draft
  // [DOC: render-boundaries]
  const selection = useMemo(() => ({time, points, box}), [time, points, box])
  const readOnly = job?.status === 'rendering'
  const valid = isValid(draft, job)
  const aspect = job ? job.meta.width / job.meta.height : FALLBACK_ASPECT

  useEffect(() => {setRange(start, end)}, [start, end])
  useLayoutEffect(() => {
    if (!job) return
    dispatch(init(job))
    seek(job.request?.prompt.time ?? job.request?.start ?? 0)
    // [DOC: late-rows]
    if (!document.documentElement.hasAttribute('data-enter')) form.current.dataset.early = ''
  }, [job])

  const submit = async event => {
    event.preventDefault()
    if (!valid || posting || !online || readOnly) return
    dispatch({posting: true, error: null})
    try {
      await postRender(job.id, {start, end, prompt: {time, points, box, mask}, options: optionsFor(job.meta, options), codec, denoise: job.meta.has_audio ? denoise : 0})
      haptic.notify('success')
      close()
    } catch (failure) {
      haptic.notify('error')
      dispatch({posting: false, error: failure.message})
    }
  }

  const note = error ? '' : !online ? OFFLINE : NOTES[job?.status] ?? ''
  return (
    <>
      <main className='editor' aria-busy={!job || undefined} data-split={aspect < SPLIT_BELOW || undefined}>
        <Viewer job={job} notice={notice} aspect={aspect} selection={selection} dispatch={dispatch} readOnly={readOnly}/>
        <Timeline job={job} start={start} end={end} time={time} dispatch={dispatch} readOnly={readOnly}/>
        <form ref={form} id={FORM} className='options' onSubmit={submit} onKeyDown={noEnter}>
          <Options meta={job?.meta} options={options} codec={codec} denoise={denoise} readOnly={readOnly} dispatch={dispatch}/>
        </form>
        <Swap as='p' className='editor-status enter' role='alert' text={error}/>
        <Swap as='p' className='editor-status enter' role='status' text={note}/>
      </main>
      {/* [DOC: submit-bar] */}
      {job && loaded && !readOnly && (
        <div className='editor-bar enter'>
          <button type='submit' form={FORM} className='editor-submit' disabled={!valid || !online || posting} aria-busy={posting || undefined}>
            <span>Make round</span>
            {posting && <span className='spinner' aria-hidden='true'/>}
          </button>
        </div>
      )}
    </>
  )
})
