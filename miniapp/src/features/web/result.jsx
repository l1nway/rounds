import {useLayoutEffect, useReducer, useRef, useState} from 'react'
import {merge, useOnline, usePresence} from '../../hooks/state.js'
import {forget, shapeOf, useMorph, useScrim} from './morph.js'

const HELD = 'Telegram refused the round: your privacy settings restrict voice and video messages. Allow the bot, then press Resend in the chat.'
const AGAIN = 'Same settings as the last round: shown again, nothing was rendered twice.'
const FREE = 'The full version was unavailable, so the free server made this round.'
const percent = new Intl.NumberFormat(undefined, {style: 'percent'})
const list = new Intl.ListFormat('en', {type: 'conjunction'})
const megabytes = new Intl.NumberFormat(undefined, {maximumFractionDigits: 1})
const mb = bytes => `${megabytes.format(bytes / 1e6)} MB`

// [DOC: web-consent]
const ABOUT = {
  lift: {
    title: 'Download the selection model',
    text: 'It outlines the object you tap, so you see exactly what the round keeps in the circle.'
  },
  follow: {
    title: 'Download the tracking model',
    text: 'It follows the selected object through the trimmed part, so the marks move with it and you can check the tracking before making the round. With WebGPU it runs on the graphics card, otherwise slower on the processor.'
  }
}
// [DOC: web-crash]
const CRASH = {
  gpu: 'This usually means the device ran out of memory. Close other apps and tabs, or switch to the processor: slower, but it needs less memory.',
  wasm: 'This usually means the device ran out of memory. Close other apps and tabs, then try again.'
}
const PARTS = {encoder: 'Image encoder', decoder: 'Mask decoder', 'mem-enc': 'Memory encoder', 'mem-attn': 'Memory attention', pointer: 'Object pointer'}
const partOf = name => PARTS[name.replace(/^(sam2\.1-(tiny|video)|edge-sam)-/, '')] ?? name

// [DOC: web-morph]
const MARK = ['.viewer-marks > .viewer-box', '.viewer-marks > .viewer-point:last-of-type']
const ORIGINS = {lift: MARK, follow: ['.viewer-tag', ...MARK], work: ['.editor-submit'], done: ['.editor-submit']}
const originOf = (selectors = []) => () => {
  const el = selectors.map(selector => document.querySelector(selector)).find(found => found?.getClientRects().length)
  return el ? shapeOf(el) : null
}

function Card({title, host, origin, open, children}) {
  const card = useRef(null)
  useMorph(card, originOf(ORIGINS[origin]), open)
  return <section ref={el => {card.current = el; host(el)}} className='web-card' role='dialog' aria-modal='true' aria-label={title}>{children}</section>
}

function Done({result: {blob, url, name, silent, remote, again, dropped = []}, user, onClose, onAnother, host, open}) {
  const online = useOnline()
  const [{sending, sent, held, error}, dispatch] = useReducer(merge, {sending: false, sent: false, held: false, error: null})

  const send = async () => {
    dispatch({sending: true, error: null})
    try {
      const {sendNote} = await import('../local/server.js')
      const answer = await sendNote(blob, name)
      dispatch({sending: false, sent: !answer.held, held: Boolean(answer.held)})
    } catch (failure) {
      dispatch({sending: false, error: failure.message})
    }
  }

  const status = error || (dropped.length > 0 && `${FREE} Left out: ${list.format(dropped)}.`) || (held && HELD) || (sent && 'Sent to your Telegram chat.') || (silent && 'No sound: this browser cannot encode audio.') || (again && !remote && AGAIN) || ''
  return (
    <Card host={host} origin='done' open={open} title='Your round'>
      {remote ? <p>{again ? 'Already sent with these settings: the round is in your Telegram chat.' : 'Sent to the server. The round arrives in your Telegram chat.'}</p> : <>
        <video className='web-note' src={url} autoPlay loop muted playsInline aria-label='Preview of the round' onClick={event => {event.currentTarget.muted = !event.currentTarget.muted}}/>
        <p className='web-size'>{mb(blob.size)}</p>
      </>}
      <p role='status' data-error={error || undefined}>{status}</p>
      <span className='web-actions'>
        {!remote && <a className='web-button' href={url} download={name}>Download</a>}
        {!remote && user && <button className='web-button' type='button' disabled={!online || sending || sent} aria-busy={sending || undefined} onClick={send}>
          {sending ? 'Sending…' : held || error ? 'Retry' : 'Send to Telegram'}
        </button>}
        <button className='web-button' type='button' data-quiet onClick={onAnother}>Another video</button>
        <button className='web-button' type='button' data-quiet onClick={onClose}>Close</button>
      </span>
    </Card>
  )
}

function Consent({consent: {kind, bytes, models = [], resolve}, host, open}) {
  const online = useOnline()
  const about = ABOUT[kind] ?? ABOUT.lift
  return (
    <Card host={host} origin={kind} open={open} title={about.title}>
      <h2>{about.title}</h2>
      <p>{about.text}</p>
      <ul className='web-files' aria-label={models[0]?.credit}>
        {models.map(({name, bytes: size}) => <li key={name}>{partOf(name)}<span>{mb(size)}</span></li>)}
      </ul>
      <p className='web-about'>{models[0]?.credit}, {mb(bytes)} once from Hugging Face. It runs on this device, so the video is not uploaded for this, and stays in this browser for offline use.</p>
      <span className='web-actions'>
        <button className='web-button' type='button' disabled={!online} onClick={() => resolve(true)}>Download ({mb(bytes)})</button>
        <button className='web-button' type='button' data-quiet onClick={() => resolve(false)}>Not now</button>
      </span>
    </Card>
  )
}

function Crash({crash, host, open, onChoose}) {
  const gpu = crash === 'gpu'
  return (
    <Card host={host} open={open} title='The page restarted'>
      <h2>The page restarted</h2>
      <p>{CRASH[crash] ?? CRASH.wasm}</p>
      <span className='web-actions'>
        {gpu && <button className='web-button' type='button' onClick={() => onChoose(true)}>Use the processor</button>}
        <button className='web-button' type='button' data-quiet={gpu || undefined} onClick={() => onChoose(false)}>{gpu ? 'Keep the graphics card' : 'OK'}</button>
      </span>
    </Card>
  )
}

const keyOf = active => {
  if (!active) return null
  if (active.kind === 'crash') return `crash:${active.crash}`
  if (active.kind === 'consent') return `consent:${active.consent.kind}:${active.consent.bytes}`
  if (active.kind === 'work') return `work:${active.work.text}:${active.work.share}`
  if (active.kind === 'done') return `done:${active.result.url ?? 'remote'}`
  return null
}

// [DOC: web-result]
export default function Result({work, result, consent, crash, user, onClose, onAnother, onCrash}) {
  const active = consent ? {kind: 'consent', consent} : crash ? {kind: 'crash', crash} : work ? {kind: 'work', work} : result ? {kind: 'done', result} : null
  const [mounted, ref] = usePresence(Boolean(active))
  const [host] = useState(() => el => {ref.current = el})
  const [prev, setPrev] = useState(active)
  if (active && keyOf(active) !== keyOf(prev)) setPrev(active)
  const item = active ?? prev
  const open = Boolean(active)
  const scrim = useScrim(open, mounted)
  useLayoutEffect(() => {if (!mounted) forget()}, [mounted])

  if (!mounted || !item) return null
  const card = {
    consent: () => <Consent host={host} open={open} consent={item.consent}/>,
    crash: () => <Crash host={host} open={open} crash={item.crash} onChoose={onCrash}/>,
    work: () => (
      <Card host={host} origin='work' open={open} title='Working'>
        <p role='status'>{item.work.text}</p>
        {item.work.share !== undefined && <><progress value={item.work.share} max={1}/><p className='web-size'>{percent.format(item.work.share)}</p></>}
      </Card>
    ),
    done: () => <Done host={host} open={open} key={item.result.url ?? 'server'} result={item.result} user={user} onClose={onClose} onAnother={onAnother}/>
  }[item.kind]
  return <div ref={scrim} className='web-backdrop' data-closing={!open || undefined}>{card()}</div>
}
