import {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react'
import {usePlayer} from '../../hooks/player.js'
import {merge} from '../../hooks/state.js'
import {post} from '../../services/api.js'
import Account from '../account/account.jsx'
import {session, tierOf} from '../account/session.js'
import {LEVELS, init} from '../editor/draft.js'
import Editor from '../editor/editor.jsx'
import {gate, needsModal, needsServer} from '../local/plan.js'
import Result from './result.jsx'

const MAX_DURATION = 60
const MAX_BYTES = 2000 * 1024 * 1024
const PREPARING = {title: 'Preparing the video…', busy: true}
const START = {user: session()?.user ?? null, source: null, notice: null, work: null, result: null, over: false, consent: null, crash: null}
// [DOC: web-local-ai]
const LABELS = {
  lift: ['Downloading selection model…', 'Preparing selection…', 'Selecting object…'],
  follow: ['Downloading tracking model…', 'Preparing tracking…', 'Tracking object…']
}
const hasFiles = event => event.dataTransfer?.types.includes('Files')

const CARRY = ['start', 'end', 'time', 'points', 'box', 'mask', 'options', 'codec', ...LEVELS.map(({key}) => key)]
const resume = job => prev => ({...init(job), ...Object.fromEntries(CARRY.map(key => [key, prev[key]]))})

const mimeOf = file => {
  if (file.type && file.type.startsWith('video/')) return file.type
  const ext = file.name?.split('.').pop()?.toLowerCase()
  return ext === 'mov' ? 'video/quicktime' : 'video/mp4'
}

const base = name => name.replace(/\.[^.]+$/, '') || 'round'

// [DOC: web-shell]
export default function WebApp() {
  const [{user, source, notice, work, result, over, consent, crash, gpu}, dispatch] = useReducer(merge, START)
  const [input, setInput] = useState(null)
  const latest = useRef(0)
  const pending = useRef(null)
  const last = useRef(null)
  const failed = usePlayer(state => state.failed)
  const tier = tierOf(user)
  // [DOC: web-local-ai]
  const job = useMemo(() => {
    if (!source) return null
    const confirm = kind => ({bytes, models}) => new Promise(resolve => dispatch({consent: {kind, bytes, models, resolve: ok => {dispatch({consent: null}); resolve(ok)}}}))
    const local = (load, kind, route) => async (want, report) => {
      const [loading, preparing, busy] = LABELS[kind]
      const [run, {awake}] = await Promise.all([load(), import('../local/awake.js')])
      try {
        return await awake(() => run(source, want, {
          confirm: confirm(kind),
          onReady: () => report({label: preparing, share: 0}),
          onPrepare: share => report({label: preparing, share}),
          onLoaded: () => report({label: busy, share: kind === 'follow' ? 0 : undefined}),
          onProgress: info => report(info ? {label: loading, share: info.share} : {label: preparing, share: 0}),
          onTrack: share => report({label: busy, share})
        }))
      } catch (error) {
        if (source.id && tier === 'pro') return post(`/api/jobs/${encodeURIComponent(source.id)}/${route}`, want)
        throw error
      }
    }
    const tracker = () => import('../local/track-local.js')
    const lift = local(() => import('../local/lift-local.js').then(module => module.segmentLocal), 'lift', 'segment')
    const follow = Object.assign(local(() => tracker().then(module => module.followLocal), 'follow', 'track'), {stop: () => tracker().then(module => module.stopFollow())})
    return {id: null, status: 'ready', max_duration: MAX_DURATION, request: null, ...source, tier, local: true, gpu: Boolean(gpu), lift, follow}
  }, [source, tier, gpu])
  // [DOC: web-crash]
  useEffect(() => {import('../local/models.js').then(({crashed, deviceOf}) => {if (crashed) dispatch({crash: crashed}); deviceOf().then(device => dispatch({gpu: device.gpu}))})}, [])
  const choose = cpu => {
    dispatch({crash: null})
    if (cpu) import('../local/models.js').then(({preferCpu}) => preferCpu())
  }
  const setUser = useCallback(next => dispatch({user: next}), [])
  const pick = useCallback(() => input?.click(), [input])

  const notices = useMemo(() => {
    const choose = {action: 'Choose a video', onAction: pick, local: true}
    return {
      empty: {...choose, title: 'Drop a video here', text: 'Or click to choose one. It stays on this device unless a step needs the server.'},
      playback: {...choose, title: 'This browser cannot play the video', text: 'Drop another file or try another browser.'}
    }
  }, [pick])

  const load = async file => {
    if (!file || work) return
    const turn = ++latest.current
    consent?.resolve(false)
    if (source) [source.proxy_url, source.filmstrip_url].forEach(url => URL.revokeObjectURL(url))
    pending.current = null
    dispatch({source: null, result: null, consent: null, notice: PREPARING})
    try {
      const {probe} = await import('../local/probe.js')
      const found = await probe(file)
      if (turn !== latest.current) return URL.revokeObjectURL(found.filmstrip_url)
      const blob = file.type?.startsWith('video/') ? file : new Blob([file], {type: mimeOf(file)})
      const proxy_url = URL.createObjectURL(blob)
      dispatch({source: {...found, file, size: file.size, name: file.name, proxy_url, type: mimeOf(file)}, notice: null})
    } catch (failure) {
      if (user && navigator.onLine && file.size <= MAX_BYTES) {
        try {
          const {prepare} = await import('../local/server.js')
          const say = text => turn === latest.current && dispatch({notice: {...PREPARING, text}})
          const found = await prepare(file, say, tier !== 'pro')
          if (turn !== latest.current) return
          dispatch({source: {...found, file, size: file.size, name: file.name}, notice: null})
          return
        } catch (serverFailure) {
          if (turn === latest.current) dispatch({notice: {...notices.empty, title: 'This video could not be opened', text: serverFailure.message}})
          return
        }
      }
      if (turn === latest.current) dispatch({notice: {...notices.empty, title: 'This video could not be opened', text: failure.message}})
    }
  }

  // [DOC: web-drop]
  const accepts = event => {
    if (!hasFiles(event)) return false
    event.preventDefault()
    return Boolean(event.target.closest?.('.viewer'))
  }
  const drop = event => {
    const inside = accepts(event)
    dispatch({over: false})
    if (inside) load(event.dataTransfer.files[0])
  }

  // [DOC: web-promote]
  useEffect(() => {
    if (tier !== 'pro' || !source || source.id || source.size > MAX_BYTES || !navigator.onLine) return
    let live = true
    // [DOC: modal-fallback]
    const run = import('../local/server.js').then(({prepare}) => prepare(source.file, () => {})).then(found => {
      if (found.oracle) throw new Error('The full version is unavailable right now')
      return found
    })
    pending.current = run.then(found => found.id, () => null)
    run.then(found => {
      if (!live) return
      const next = {...source, ...found, meta: {...source.meta, ...found.meta, tags: {...source.meta?.tags, ...found.meta?.tags}, off: source.meta.off, hdr: source.meta.hdr}}
      dispatch({source: {...next, resume: resume(next)}})
      ;[source.proxy_url, source.filmstrip_url].forEach(url => URL.revokeObjectURL(url))
    }, error => {if (import.meta.env.DEV) console.warn('The server copy failed:', error)})
    return () => {live = false}
  }, [tier, source])

  // [DOC: web-same-render]
  const send = async (current, body) => {
    const key = JSON.stringify(body)
    const done = last.current?.file === current.file && last.current.key === key && last.current.result
    if (done) return dispatch({result: {...done, again: true, url: done.blob && URL.createObjectURL(done.blob)}})
    const remote = needsServer(body, current)
    dispatch({work: {text: remote ? 'Uploading…' : 'Rendering…', share: 0}})
    try {
      if (remote) {
        const {renderOnServer} = await import('../local/server.js')
        const modal = needsModal(body, current)
        const id = modal ? current.id ?? await pending.current : null
        const {dropped} = await renderOnServer(current.file, body, text => dispatch({work: {text}}), {id, oracle: !modal && tier === 'pro'})
        last.current = {file: current.file, key, result: {remote: true, dropped}}
        dispatch({work: null, result: {remote: true, dropped}})
      } else {
        const [{renderNote}, {awake}] = await Promise.all([import('../local/render.js'), import('../local/awake.js')])
        const {blob, silent} = await awake(() => renderNote(current.file, current.meta, body, (share, text = 'Rendering…') => dispatch({work: {text, share}})))
        const made = {blob, silent, name: `${base(current.name)}-round.mp4`}
        last.current = {file: current.file, key, result: made}
        dispatch({work: null, result: {...made, url: URL.createObjectURL(blob)}})
      }
    } catch (failure) {
      dispatch({work: null})
      throw failure
    }
  }

  const close = () => {
    if (result?.url) {
      const url = result.url
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    dispatch({result: null})
  }

  return (
    <div className='web' data-over={over || undefined}
      onDragOver={event => dispatch({over: accepts(event)})}
      onDragLeave={event => event.currentTarget.contains(event.relatedTarget) || dispatch({over: false})} onDrop={drop}>
      <Account user={user} onUser={setUser}/>
      <Editor job={job} notice={notice ?? (source ? (failed ? notices.playback : null) : notices.empty)} send={send} gate={gate} retry/>
      <input ref={setInput} type='file' accept='video/*' hidden onChange={event => {load(event.target.files[0]); event.target.value = ''}}/>
      <Result work={work} result={result} consent={consent} crash={crash} user={user} onClose={close} onAnother={() => {close(); pick()}} onCrash={choose}/>
    </div>
  )
}
