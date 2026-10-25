import {useCallback, useEffect, useMemo, useReducer} from 'react'
import {merge, useOnline} from '../../hooks/state.js'
import {getJob, jobId} from '../../services/api.js'
import {inTelegram} from '../../services/telegram.js'

const POLL = 2000
const OUTSIDE = {title: 'Open it from the bot', text: 'This editor runs inside Telegram. Send a video to the bot and open the editor from its reply.'}
const MISSING = {title: 'No video in the link', text: 'Open the editor from the button under the bot’s reply to your video.'}
const LOADING = {title: 'Loading the video…', busy: true}
const INGESTING = {title: 'Preparing the video…', text: 'Large files take a minute. This page updates by itself.', busy: true}
const BROKEN = {title: 'This video could not be prepared', text: 'Send it to the bot again.'}
const OFFLINE ={title: 'You are offline', text: 'The video loads as soon as the connection is back.'}

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
    if (job) return job.proxy_url ? null : BROKEN
    if (error) return {title: 'Could not load the video', text: error, action: 'Try again', onAction: retry}
    return online ? LOADING : OFFLINE
  }, [blocked, job, error, online, retry])

  return useMemo(() => ({job: settled && job.proxy_url ? job : null, notice}), [settled, job, notice])
}
