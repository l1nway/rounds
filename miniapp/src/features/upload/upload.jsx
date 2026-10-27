import {useReducer} from 'react'
import Swap from '../../components/swap.jsx'
import {merge, useOnline} from '../../hooks/state.js'
import {sendParts, startUpload} from '../../services/api.js'

const MAX_BYTES = 2000 * 1024 * 1024
const TEXTS = {
  idle: 'Drop a video here or choose a file, up to 2000 MB.',
  offline: 'You are offline. Uploading needs the connection.',
  done: 'Uploaded. The bot prepares it and sends the editor to your Telegram chat.',
  big: 'The file is over 2000 MB.',
  notVideo: 'This is not a video file.'
}
const percent = new Intl.NumberFormat(undefined, {style: 'percent'})
const IDLE = {file: null, job: null, done: null, sent: 0, total: 1, busy: false, finished: false, error: null, over: false}

// [DOC: browser-upload]
export default function Upload() {
  const online = useOnline()
  const [{file, job, done, sent, total, busy, finished, error, over}, dispatch] = useReducer(merge, IDLE)

  const run = async (next, started = null, got = new Set()) => {
    dispatch({file: next, busy: true, finished: false, error: null, sent: got.size})
    try {
      const upload = started ?? await startUpload(next)
      dispatch({job: upload, done: got, total: Math.ceil(next.size / upload.chunk)})
      await sendParts(upload, next, got, n => dispatch({sent: n}))
      dispatch({busy: false, finished: true})
    } catch (failure) {
      dispatch({busy: false, error: failure.message})
    }
  }

  const pick = next => {
    if (!next || busy) return
    const problem = !next.type.startsWith('video/') ? TEXTS.notVideo : next.size > MAX_BYTES ? TEXTS.big : null
    if (problem) return dispatch({...IDLE, error: problem})
    dispatch({job: null, done: null})
    run(next)
  }

  const drop = event => {
    event.preventDefault()
    dispatch({over: false})
    if (online) pick(event.dataTransfer.files[0])
  }

  const progress = busy ? `Uploading ${file.name}… ${percent.format(sent / total)}` : ''
  const status = finished ? TEXTS.done : error || progress || (online ? TEXTS.idle : TEXTS.offline)
  const resumable = error && job && file
  return (
    <div className='upload enter' data-over={over || undefined} onDrop={drop}
      onDragOver={event => {event.preventDefault(); dispatch({over: true})}} onDragLeave={() => dispatch({over: false})}>
      <Swap as='p' className='upload-status' role='status' text={status}/>
      {busy && <progress className='upload-bar' value={sent} max={total}/>}
      <span className='upload-actions'>
        {resumable && <button className='upload-button' type='button' disabled={!online} onClick={() => run(file, job, done)}>Continue</button>}
        <label className='upload-button' data-quiet={resumable || undefined} aria-disabled={!online || busy || undefined}>
          <input type='file' accept='video/*' disabled={!online || busy} onChange={event => {pick(event.target.files[0]); event.target.value = ''}}/>
          {finished ? 'Upload another' : 'Choose a video'}
        </label>
      </span>
    </div>
  )
}
