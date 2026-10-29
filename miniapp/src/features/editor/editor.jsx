import {memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState} from 'react'
import Swap from '../../components/swap.jsx'
import {seek, setRange, usePlayer} from '../../hooks/player.js'
import {merge, useOnline} from '../../hooks/state.js'
import {launchAspect} from '../../services/api.js'
import {haptic} from '../../services/telegram.js'
import Timeline from '../timeline/timeline.jsx'
import Viewer from '../viewer/viewer.jsx'
import {init, isValid, levelsFor, optionsFor, rowCount} from './draft.js'
import Options from './options.jsx'
import './editor.css'

const NOTES = {
  rendering: 'Already submitted. Progress comes in the chat.',
  done: 'Already made. Edit and make another one.',
  failed: 'The last render failed. Adjust and retry.'
}
const OFFLINE = 'Offline: editing works, sending waits.'
const FORM = 'round'
const PLAIN = {network: true}
const FALLBACK_ASPECT = launchAspect() ?? 16 / 9
// [DOC: split-layout]
const SPLIT_BELOW = 1.7
const SPLIT_QUERY = '(orientation: landscape) and (min-width: 900px) and (min-height: 560px)'
const MOVE = {duration: 600, easing: 'cubic-bezier(0.4, 0, 0.2, 1)'}
const MOVED = ['.viewer', '.timeline', '.options']  // the viewer first
const px = value => `${value}px`

function useSplit(aspect) {
  const [wide, setWide] = useState(() => matchMedia(SPLIT_QUERY).matches)
  useEffect(() => {
    const query = matchMedia(SPLIT_QUERY)
    const sync = () => setWide(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  return wide && aspect < SPLIT_BELOW
}

const measureIn = root => MOVED.map(selector => root.current.querySelector(selector))
const stageOf = root => root.current.querySelector('.viewer-stage').getBoundingClientRect()
const SAMPLES = 16
const lerp = (a, b, t) => a + (b - a) * t

// [DOC: split-flip]
function useFlip(root, split, aspect) {
  const last = useRef({split, aspect, rects: [], stage: null})
  useLayoutEffect(() => {
    const prev = last.current
    const flip = prev.split !== split && !matchMedia('(prefers-reduced-motion: reduce)').matches
    if (flip) measureIn(root)[0].getAnimations().filter(({id}) => id === 'fit').forEach(animation => animation.cancel())
    const els = measureIn(root), rects = els.map(el => el.getBoundingClientRect()), stage = stageOf(root)
    if (flip) els.forEach((el, i) => {
      const [from, to] = [prev.rects[i], rects[i]]
      // slide from the old spot: the offset is what the new layout is missing
      const frames = {
        translate: [`${px(from.left - to.left)} ${px(from.top - to.top)}`, '0px 0px'],
        width: [px(from.width), px(to.width)]
      }
      // the stage's own size interpolates linearly (animated below), so the picture never swells in between: its aspect follows per sample
      if (!i) Object.assign(frames, {height: [px(from.height), px(to.height)], '--aspect': Array.from({length: SAMPLES + 1}, (_, k) => lerp(prev.stage.width, stage.width, k / SAMPLES) / lerp(prev.stage.height, stage.height, k / SAMPLES))})
      el.animate(frames, {...MOVE, id: 'flip'})
      if (!i) el.querySelector('.viewer-stage').animate({width: [px(prev.stage.width), px(stage.width)]}, {...MOVE, id: 'flip'})
    })
    last.current = {split, aspect, rects, stage}
  })
  useEffect(() => {
    const node = root.current
    // rects taken mid-animation would skew the next flip, so settle them when motion ends
    const remeasure = () => {
      if (node.getAnimations({subtree: true}).some(({effect}) => effect.getComputedTiming().iterations !== Infinity)) return
      last.current.rects = measureIn(root).map(el => el.getBoundingClientRect())
      last.current.stage = stageOf(root)
    }
    addEventListener('resize', remeasure)
    node.addEventListener('animationend', remeasure)
    node.addEventListener('transitionend', remeasure)
    return () => {
      removeEventListener('resize', remeasure)
      node.removeEventListener('animationend', remeasure)
      node.removeEventListener('transitionend', remeasure)
    }
  }, [root])
}

// [DOC: glide-wait]
const GLIDES = new Set(['fit', 'flip'])
function useGlide(root, split, aspect) {
  const [state, setState] = useState({gliding: false, glided: false})
  const run = useRef(0)
  useLayoutEffect(() => {
    const token = ++run.current
    const moving = root.current.getAnimations({subtree: true}).filter(({id}) => GLIDES.has(id))
    // a layout effect: the glide only exists after the commit's layout effects, and the rows must not paint before the state follows
    // oxlint-disable-next-line react-hooks-js/set-state-in-effect
    if (!moving.length) return setState(prev => prev.gliding ? {gliding: false, glided: true} : prev)
    setState({gliding: true, glided: true})
    Promise.allSettled(moving.map(animation => animation.finished)).then(() => {
      if (run.current === token) setState({gliding: false, glided: true})
    })
  }, [root, split, aspect])
  return state
}

// [DOC: submit-form]
const noEnter = event => {if (event.key === 'Enter') event.preventDefault()}

// [DOC: editor-draft]
export default memo(function Editor({job, notice, send, gate, retry}) {
  const online = useOnline()
  const loaded = usePlayer(state => state.loaded)
  const [draft, dispatch] = useReducer(merge, job, init)
  const form = useRef(null)
  const {start, end, time, points, box, mask, options, codec, stabilize, deblur, denoise, look, exposure, adjusting, previewing, posting, error} = draft
  // [DOC: render-boundaries]
  const selection = useMemo(() => ({time, points, box}), [time, points, box])
  const readOnly = job?.status === 'rendering'
  // [DOC: editor-seams]
  const plan = gate?.(draft, job) ?? PLAIN
  const valid = isValid(draft, job) && !plan.block
  const reachable = online || !plan.network
  const aspect = job ? job.meta.width / job.meta.height : FALLBACK_ASPECT
  const main = useRef(null)
  const split = useSplit(aspect)
  useFlip(main, split, aspect)
  const {gliding, glided} = useGlide(main, split, aspect)

  useEffect(() => {setRange(start, end)}, [start, end])
  useLayoutEffect(() => {
    if (!job) return
    dispatch(job.resume ?? init(job))
    if (!job.resume) seek(job.request?.prompt.time ?? job.request?.start ?? 0)
    // [DOC: late-rows]
    if (!document.documentElement.hasAttribute('data-enter')) form.current.dataset.early = ''
  }, [job])

  const submit = async event => {
    event.preventDefault()
    if (!valid || posting || !reachable || readOnly) return
    dispatch({posting: true, error: null})
    try {
      await send(job, {start, end, prompt: {time, points, box, mask}, options: optionsFor(job, options), codec, ...levelsFor(job, draft)})
      haptic.notify('success')
      dispatch({posting: false})
    } catch (failure) {
      haptic.notify('error')
      dispatch({posting: false, error: failure.message})
    }
  }

  const note = error ? '' : plan.note ?? (!reachable ? OFFLINE : NOTES[job?.status] ?? '')
  // [DOC: submit-bar]
  const bar = job && loaded && !gliding && !readOnly && (
    <div className='editor-bar enter' data-inline={split || undefined} data-glided={glided || undefined} style={{'--i': `calc(${rowCount(job.meta) + 1} + 3 * var(--early, 0))`}}>
      <button type='submit' form={FORM} className='editor-submit' disabled={!valid || !reachable || posting} aria-busy={posting || undefined}>
        <span>{retry && error ? 'Retry' : 'Make round'}</span>
        {posting && <span className='spinner' aria-hidden='true'/>}
      </button>
    </div>
  )
  return (
    <>
      <main ref={main} className='editor' aria-busy={!job || undefined} data-split={split || undefined} data-glided={glided || undefined}>
        <Viewer job={job} notice={notice} aspect={aspect} selection={selection} start={start} end={end}
          look={look} exposure={exposure} adjusting={adjusting} dispatch={dispatch} readOnly={readOnly}/>
        <Timeline job={job} start={start} end={end} time={time} dispatch={dispatch} readOnly={readOnly}/>
        <form ref={form} id={FORM} className='options' onSubmit={submit} onKeyDown={noEnter}>
          <Options ready={loaded && !gliding} meta={job?.meta} tier={job?.tier} local={job?.local} options={options} codec={codec} stabilize={stabilize} deblur={deblur} denoise={denoise} look={look} exposure={exposure}
            locked={previewing} readOnly={readOnly} dispatch={dispatch}/>
          {split && bar}
        </form>
        <Swap as='p' className='editor-status enter' role='alert' text={error}/>
        <Swap as='p' className='editor-status enter' role='status' text={note}/>
      </main>
      {!split && bar}
    </>
  )
})
