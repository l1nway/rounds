import {useReducer, useState} from 'react'
import {merge, useOnline, usePresence} from '../../hooks/state.js'

const HELD = 'Telegram refused the round: your privacy settings restrict voice and video messages. Allow the bot, then press Resend in the chat.'
const percent = new Intl.NumberFormat(undefined, {style: 'percent'})
const megabytes = new Intl.NumberFormat(undefined, {maximumFractionDigits: 1})

function Card({title, host, children}) {
  return (
    <div ref={host} className='web-backdrop'>
      <section className='web-card' role='dialog' aria-modal='true' aria-label={title}>{children}</section>
    </div>
  )
}

function Done({result: {blob, url, name, silent, remote}, user, onClose, onAnother, host}) {
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

  const status = error || (held && HELD) || (sent && 'Sent to your Telegram chat.') || (silent && 'No sound: this browser cannot encode audio.') || ''
  return (
    <Card host={host} title='Your round'>
      {remote ? <p>Sent to the server. The round arrives in your Telegram chat.</p> : <>
        <video className='web-note' src={url} autoPlay loop muted playsInline aria-label='Preview of the round' onClick={event => {event.currentTarget.muted = !event.currentTarget.muted}}/>
        <p className='web-size'>{megabytes.format(blob.size / 1e6)} MB</p>
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

const keyOf = active => {
  if (!active) return null
  if (active.kind === 'consent') return `consent:${active.consent.bytes}`
  if (active.kind === 'work') return `work:${active.work.text}:${active.work.share}`
  if (active.kind === 'done') return `done:${active.result.url ?? 'remote'}`
  return null
}

// [DOC: web-result]
export default function Result({work, result, consent, user, onClose, onAnother}) {
  const online = useOnline()
  const active = consent ? {kind: 'consent', consent} : work ? {kind: 'work', work} : result ? {kind: 'done', result} : null
  const [mounted, host] = usePresence(Boolean(active))
  const [prev, setPrev] = useState(active)
  if (active && keyOf(active) !== keyOf(prev)) setPrev(active)
  const item = active ?? prev

  if (!mounted || !item) return null

  if (item.kind === 'consent') {
    const {bytes, resolve} = item.consent
    const size = `${megabytes.format(bytes / 1e6)} MB`
    return (
      <Card host={host} title='Download AI model'>
        <p>Object selection runs on your device and needs a one-time download ({size}). It stays cached in this browser for offline use.</p>
        <span className='web-actions'>
          <button className='web-button' type='button' disabled={!online} onClick={() => resolve(true)}>Download ({size})</button>
          <button className='web-button' type='button' data-quiet onClick={() => resolve(false)}>Not now</button>
        </span>
      </Card>
    )
  }
  if (item.kind === 'work') return (
    <Card host={host} title='Working'>
      <p role='status'>{item.work.text}</p>
      {item.work.share !== undefined && <><progress value={item.work.share} max={1}/><p className='web-size'>{percent.format(item.work.share)}</p></>}
    </Card>
  )
  return <Done host={host} key={item.result.url ?? 'server'} result={item.result} user={user} onClose={onClose} onAnother={onAnother}/>
}
