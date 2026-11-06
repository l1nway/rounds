import {useEffect, useRef, useState} from 'react'
import {ms, PROBES} from './probes.js'
import './check.css'

// [DOC: device-check]
const RUN = 'rounds.check-run'
const BEAT = 1000
const AFTER = 120

// [DOC: check-modes]
const MODES = [
  ['all', 'Run all', ['env', 'pace', 'webgpu', 'gpuBench', 'media', 'light', 'lift']],
  ['gpu', 'GPU speed', ['env', 'pace', 'webgpu', 'gpuBench']],
  ['light', 'Light only', ['env', 'pace', 'light']],
  ['lift-gpu', 'Lift on GPU', ['env', 'pace', 'lift']],
  ['lift-cpu', 'Lift on CPU', ['env', 'pace', 'liftCpu']],
  ['meter', 'Memory meter', ['env', 'meter']],
  ['lift-meter', 'Lift, then meter', ['env', 'lift', 'meter']]
]
// [DOC: check-lift-settings]
const CACHES = ['lazyRelease', 'bucket', 'simple']
const RUNS = [1, 3, 5]
const SETTINGS = {cache: 'lazyRelease', runs: 3, release: true}

const store = () => {try {return localStorage} catch {return null}}
const linesOf = (name, result) => Object.entries(result).map(([key, value]) => `${name}.${key}: ${value}`)
const secs = value => `${(Math.max(0, value) / 1000).toFixed(1)} s`

// [DOC: check-beat]
const load = () => {try {return JSON.parse(store()?.getItem(RUN))} catch {return null}}
const save = record => {try {store()?.setItem(RUN, JSON.stringify(record))} catch { /* full */ }}

const verdict = ({mode, step, stepAt, end, beat, hiddenAt}) => {
  const gone = hiddenAt ? `, the app went to the background ${secs(hiddenAt - (end ?? stepAt))} after ${end ? 'the finish' : 'the step began'}` : ''
  if (!end) return `previous run (${mode}) stopped during ${step}, last beat ${secs(beat - stepAt)} into it${gone}`
  if (beat - end >= (AFTER - 2) * 1000) return `previous run (${mode}) survived ${AFTER} s after the finish`
  return `previous run (${mode}) last beat ${secs(beat - end)} after the finish${gone || ' (it died, or the Mini App was closed)'}`
}

const previous = () => {
  const record = load()
  return record ? [verdict(record), '--- previous report ---', ...record.lines] : []
}

const Pick = ({label, name, value, options, onChange}) => (
  <label>{label} <select name={name} value={value} onChange={onChange}>{options.map(option => <option key={option} value={option}>{option}</option>)}</select></label>
)

// [DOC: device-check]
export default function Check({job}) {
  const [lines, setLines] = useState(previous)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const [settings, setSettings] = useState(SETTINGS)
  const pre = useRef(null)
  const lock = useRef(false)
  const live = useRef({record: null, timer: 0})

  useEffect(() => {
    const state = live.current
    const hide = () => {const {record} = state; if (document.hidden && record && !record.hiddenAt) {record.hiddenAt = Date.now(); save(record)}}
    document.addEventListener('visibilitychange', hide)
    return () => {clearInterval(state.timer); document.removeEventListener('visibilitychange', hide)}
  }, [])

  const beat = () => {
    const record = live.current.record
    record.beat = Date.now()
    if (record.end && record.beat - record.end >= AFTER * 1000) clearInterval(live.current.timer)
    if (!record.hiddenAt) save(record)
  }

  const pick = ({target: {name, value, checked, type}}) => setSettings(prev => ({...prev, [name]: type === 'checkbox' ? checked : name === 'runs' ? Number(value) : value}))

  const run = async ({currentTarget: {dataset: {mode}}}) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setCopied('')
    const names = MODES.find(([key]) => key === mode)[2]
    const out = [`date: ${new Date().toISOString()}`, `mode: ${mode}`, `lift: cache ${settings.cache}, runs ${settings.runs}, release ${settings.release}`]
    const record = live.current.record = {mode, lines: out, step: '', stepAt: Date.now(), beat: Date.now()}
    clearInterval(live.current.timer)
    live.current.timer = setInterval(beat, BEAT)
    setLines(out)
    for (const name of names) {
      const note = detail => {record.step = detail ? `${name} ${detail}` : name; record.stepAt = Date.now(); save(record)}
      note()
      const t0 = performance.now()
      try {out.push(...linesOf(name, await PROBES[name](job, note, settings)), `${name}.took: ${ms(performance.now() - t0)}`)} catch (error) {out.push(`${name}: failed: ${error?.message || error}`)}
      setLines([...out])
    }
    record.end = Date.now()
    save(record)
    lock.current = false
    setBusy(false)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied('Copied')
    } catch {
      getSelection()?.selectAllChildren(pre.current)
      setCopied('Selected: copy it from the menu')
    }
  }

  return (
    <details className='check'>
      <summary>Device check</summary>
      <p className='check-note'>Measures this device for local processing. It downloads the models once: about 40 MB on a phone. Run one button per fresh open and wait 2 minutes after it. Memory meter fills the GPU until the app dies: reopen it to read the result.</p>
      <fieldset className='check-settings' disabled={busy}>
        <Pick label='Lift cache' name='cache' value={settings.cache} options={CACHES} onChange={pick}/>
        <Pick label='Runs' name='runs' value={settings.runs} options={RUNS} onChange={pick}/>
        <label><input type='checkbox' name='release' checked={settings.release} onChange={pick}/> Release after</label>
      </fieldset>
      <div className='check-actions'>
        {MODES.map(([mode, label]) => <button key={mode} type='button' data-mode={mode} onClick={run} disabled={busy} aria-busy={busy || undefined}>{label}</button>)}
        <button type='button' onClick={copy} disabled={busy || !lines.length}>Copy report</button>
      </div>
      <p className='check-note' aria-live='polite'>{copied}</p>
      {lines.length > 0 && <pre ref={pre}>{lines.join('\n')}</pre>}
    </details>
  )
}
