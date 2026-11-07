import {useCallback, useEffect, useMemo, useReducer, useState} from 'react'
import {merge, useOnline} from '../../hooks/state.js'
import {getJob, jobId, jobPath, post, postRender} from '../../services/api.js'
import {close, inTelegram, tg} from '../../services/telegram.js'
import {attachLocal} from '../local/attach.js'
import {progress} from '../viewer/follow.js'

const POLL = 2000
const OUTSIDE = {title: 'Open it from the bot', text: 'This editor runs inside Telegram. Send a video to the bot and open the editor from its reply.'}
const MISSING = {title: 'No video in the link', text: 'Open the editor from the button under the bot’s reply to your video.'}
const LOADING = {title: 'Loading the video…', busy: true}
const INGESTING = {title: 'Preparing the video…', text: 'Large files take a minute. This page updates by itself.', busy: true}
const BROKEN = {title: 'This video could not be prepared', text: 'Send it to the bot again.'}
const OFFLINE = {title: 'You are offline', text: 'The video loads as soon as the connection is back.'}
// [DOC: miniapp-local]
const PROXY_LONG = 960
const megabytes = new Intl.NumberFormat('en', {maximumFractionDigits: 0})
const ABOUT = {lift: 'the selection model: it outlines the object you tap', follow: 'the tracking model: it follows the object so you can check it before the round'}
const consent = kind => ({bytes}) => new Promise(resolve => tg()?.isVersionAtLeast('6.2')
  ? tg().showConfirm(`Download ${ABOUT[kind]}? ${megabytes.format(bytes / 1e6)} MB, once: it stays on this phone and runs here.`, resolve)
  : resolve(true))
const proxyMeta = meta => {
  const k = Math.min(1, PROXY_LONG / Math.max(meta.width, meta.height))
  return {...meta, width: Math.round(meta.width * k / 2) * 2, height: Math.round(meta.height * k / 2) * 2}
}
const withLocal = job => {
  const source = {...job, meta: proxyMeta(job.meta), file: job.proxy_url, name: job.id, size: 0}
  const server = job.tier === 'pro' && ((route, want) => post(`${jobPath(job.id)}/${route}`, want))
  return {...job, proxy: source, ...attachLocal(source, {tier: job.tier, confirm: consent, server})}
}
// [DOC: crash-note]
const PLAIN = {network: true}
const guarded = () => {try {return Boolean(localStorage.getItem('rounds.track-guard'))} catch {return false}}
// [DOC: miniapp-track]
const WAIT = 60_000
const FOLLOWING = 'Following the object…'

const follows = ({meta}, {prompt, options}) => prompt.time !== null && !prompt.crop && (prompt.box || prompt.points.some(point => point[2] === 1))
  && (meta.width !== meta.height || options.zoom)

const deviceTrack = async (job, body) => {
  const [{localOff}, {trackSamples}, {awake}] = await Promise.all([import('../local/models.js'), import('../local/track-local.js'), import('../local/awake.js')])
  if (localOff()) return null
  const say = share => progress.set({follow: {label: FOLLOWING, share}})
  say(0)
  try {
    return await awake(() => trackSamples(job.proxy.file, job.proxy.meta, body, performance.now() + WAIT, say))
  } catch (error) {
    if (import.meta.env.DEV) console.warn(error)
    return null
  } finally {progress.set({follow: null})}
}

// [DOC: miniapp-track]
export const sendRender = async (job, body) => {
  const track = job.proxy && follows(job, body) ? await deviceTrack(job, body) : null
  await postRender(job.id, track ? {...body, track} : body)
  close()
}

// [DOC: job-states]
export default function useJob() {
  const online = useOnline()
  const [{id, blocked, job, error, attempt}, dispatch] = useReducer(merge, {id: null, blocked: null, job: null, error: null, attempt: 0})
  const settled = Boolean(job && job.status !== 'ingesting')

  useEffect(() => {
    if (!inTelegram()) dispatch({blocked: OUTSIDE})
    else if (!jobId()) dispatch({blocked: MISSING})
    else dispatch({id: jobId()})
  }, [])

  useEffect(() => {
    if (!id || !online || settled) return
    let live = true
    getJob(id).then(next => live && dispatch({job: next, error: null}), failure => live && dispatch({error: failure.message}))
    return () => {live = false}
  }, [id, online, settled, attempt])

  useEffect(() => {
    if (job?.status !== 'ingesting' || !online) return
    const timer = setTimeout(() => dispatch(prev => ({attempt: prev.attempt + 1})), POLL)
    return () => clearTimeout(timer)
  }, [job, online])

  const retry = useCallback(() => dispatch(prev => ({attempt: prev.attempt + 1, error: null})), [])

  const notice = useMemo(() => {
    if (blocked) return blocked
    if (job?.status === 'ingesting') return INGESTING
    if (job) return job.proxy_url ? null : {...BROKEN, text: [job.error, BROKEN.text].filter(Boolean).join('. ')}
    if (error) return {title: 'Could not load the video', text: error, action: 'Try again', onAction: retry}
    return online ? LOADING : OFFLINE
  }, [blocked, job, error, online, retry])

  const usable = settled && job.proxy_url ? job : null
  const local = useMemo(() => usable && withLocal(usable), [usable])
  const [crash, setCrash] = useState(null)
  // [DOC: crash-note]
  useEffect(() => {if (guarded()) import('../local/models.js').then(({crashNote}) => crashNote() && setCrash(() => crashNote))}, [])
  const gate = useMemo(() => crash && (() => {const note = crash(); return note ? {network: true, note} : PLAIN}), [crash])
  return useMemo(() => ({job: local, notice, gate}), [local, notice, gate])
}
