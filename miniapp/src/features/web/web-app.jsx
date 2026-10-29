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
const SYNC_FAILED = 'The server could not prepare this video: following, lift and the HDR preview are unavailable.'
const PREPARING = {title: 'Preparing the video…', busy: true}
const START = {user: session()?.user ?? null, source: null, notice: null, work: null, result: null, over: false, sync: null, consent: null}
const hasFiles = event => event.dataTransfer?.types.includes('Files')

const CARRY = ['start', 'end', 'time', 'points', 'box', 'mask', 'options', 'codec', ...LEVELS.map(({key}) => key)]
const resume = job => prev => ({...init(job), ...Object.fromEntries(CARRY.map(key => [key, prev[key]]))})

const base = name => name.replace(/\.[^.]+$/, '') || 'round'

// [DOC: web-shell]
export default function WebApp() {
  const [{user, source, notice, work, result, over, sync, consent}, dispatch] = useReducer(merge, START)
  const [input, setInput] = useState(null)
  const latest = useRef(0)
  const pending = useRef(null)
  const failed = usePlayer(state => state.failed)
  const tier = tierOf(user)
  const lift = useCallback(async want => {
    const {segmentLocal} = await import('../local/lift-local.js')
    dispatch({sync: 'Selecting object…'})
    try {
      return await segmentLocal(source, want, {
        confirm: ({bytes}) => new Promise(resolve => dispatch({consent: {bytes, resolve: ok => {dispatch({consent: null}); resolve(ok)}}})),
        onProgress: info => dispatch({sync: info ? `Downloading AI model… ${Math.round(info.share * 100)}%` : 'Selecting object…'})
      })
    } catch (error) {
      if (source?.id && tier === 'pro') return post(`/api/jobs/${encodeURIComponent(source.id)}/segment`, want)
      throw error
    } finally {
      dispatch({sync: null})
    }
  }, [source, tier])
  const follow = useCallback(async want => {
    const {followLocal} = await import('../local/track-local.js')
    dispatch({sync: 'Tracking object… 0%'})
    try {
      return await followLocal(source, want, {
        confirm: ({bytes}) => new Promise(resolve => dispatch({consent: {bytes, resolve: ok => {dispatch({consent: null}); resolve(ok)}}})),
        onProgress: info => dispatch({sync: info ? `Downloading AI model… ${Math.round(info.share * 100)}%` : 'Tracking object…'}),
        onTrack: share => dispatch({sync: `Tracking object… ${Math.round(share * 100)}%`})
      })
    } catch (error) {
      if (source?.id && tier === 'pro') return post(`/api/jobs/${encodeURIComponent(source.id)}/track`, want)
      throw error
    } finally {
      dispatch({sync: null})
    }
  }, [source, tier])
  const job = useMemo(() => source && {id: null, status: 'ready', max_duration: MAX_DURATION, request: null, ...source, tier, local: true, lift, follow}, [source, tier, lift, follow])
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
    dispatch({source: null, result: null, sync: null, consent: null, notice: PREPARING})
    try {
      const [{probe}, {deviceOf}] = await Promise.all([import('../local/probe.js'), import('../local/models.js')])
      const [found, dev] = await Promise.all([probe(file), deviceOf()])
      if (turn !== latest.current) return
      dispatch({source: {...found, file, size: file.size, name: file.name, gpu: dev.gpu, proxy_url: URL.createObjectURL(file)}, notice: null})
    } catch (failure) {
      if (user && navigator.onLine && file.size <= MAX_BYTES) {
        try {
          const {prepare} = await import('../local/server.js')
          const say = text => turn === latest.current && dispatch({sync: text})
          const found = await prepare(file, say, tier !== 'pro')
          if (turn !== latest.current) return
          dispatch({source: {...found, file, size: file.size, name: file.name}, notice: null, sync: null})
          return
        } catch (serverFailure) {
          if (turn === latest.current) dispatch({sync: null, notice: {...notices.empty, title: 'This video could not be opened', text: serverFailure.message}})
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
    const say = text => live && dispatch({sync: text})
    const run = import('../local/server.js').then(({prepare}) => prepare(source.file, say))
    pending.current = run.then(found => found.id, () => null)
    run.then(found => {
      if (!live) return
      const next = {...source, ...found, meta: {...source.meta, ...found.meta, tags: {...source.meta?.tags, ...found.meta?.tags}, off: source.meta.off, hdr: source.meta.hdr}}
      dispatch({sync: null, source: {...next, resume: resume(next)}})
      ;[source.proxy_url, source.filmstrip_url].forEach(url => URL.revokeObjectURL(url))
    }, () => live && dispatch({sync: SYNC_FAILED}))
    return () => {live = false}
  }, [tier, source])

  const send = async (current, body) => {
    const remote = needsServer(body, current)
    dispatch({work: {text: remote ? 'Uploading…' : 'Rendering…', share: 0}})
    try {
      if (remote) {
        const {renderOnServer} = await import('../local/server.js')
        const modal = needsModal(body, current)
        const id = modal ? current.id ?? await pending.current : null
        await renderOnServer(current.file, body, text => dispatch({work: {text}}), {id, oracle: !modal && tier === 'pro'})
        dispatch({work: null, result: {remote: true}})
      } else {
        const {renderNote} = await import('../local/render.js')
        const {blob, silent} = await renderNote(current.file, current.meta, body, share => dispatch({work: {text: 'Rendering…', share}}))
        dispatch({work: null, result: {blob, silent, url: URL.createObjectURL(blob), name: `${base(current.name)}-round.mp4`}})
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
      <Editor job={job} notice={notice ?? (source ? failed && notices.playback : notices.empty) ?? null} send={send} gate={gate} retry/>
      {sync && <p className='web-sync' role='status'>{sync}</p>}
      <input ref={setInput} type='file' accept='video/*' hidden onChange={event => {load(event.target.files[0]); event.target.value = ''}}/>
      <Result work={work} result={result} consent={consent} user={user} onClose={close} onAnother={() => {close(); pick()}}/>
    </div>
  )
}
