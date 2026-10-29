import {CODECS, LEVELS, OPTIONS, levelsFor, optionsFor} from '../editor/draft.js'

const MAX_BYTES = 2000 * 1024 * 1024
const LOCAL_OPTIONS = new Set(['zoom', 'loudnorm', 'denoise', 'look', 'exposure', 'metadata'])
const need = key => [...OPTIONS, ...LEVELS].find(item => item.key === key).need
const labelOf = key => CODECS.find(codec => codec.key === key).label
const picked = ({box, points}) => Boolean(box) || points.some(point => point[2] === 1)
const localLevel = ({key, local}, body) => LOCAL_OPTIONS.has(key) && (!(local < 1) || body[key] <= local)

// [DOC: local-plan]
export const needsServer = (body, job) =>
  Object.entries(body.options).some(([key, on]) => on && !LOCAL_OPTIONS.has(key)) || LEVELS.some(level => body[level.key] && !localLevel(level, body))
  || (job.gpu === false && picked(body.prompt)) || job.meta.off.includes(body.codec) || Boolean(job.meta.hdr)

// [DOC: local-modal]
export const needsModal = (body, job) => job.tier === 'pro' && (picked(body.prompt)
  || Object.entries(body.options).some(([key, on]) => on && need(key) === 'pro')
  || LEVELS.some(level => body[level.key] && !localLevel(level, body) && level.need === 'pro'))

export const gate = (draft, job) => {
  if (!job) return {network: true}
  const off = job.meta.off
  const body = {options: optionsFor(job, draft.options), prompt: draft, codec: draft.codec, ...levelsFor(job, draft)}
  if (!needsServer(body, job)) return {network: false}
  if (job.tier === 'local') {
    if (job.gpu === false && picked(body.prompt)) return {block: true, note: 'Tracking requires WebGPU. Sign in to render on the server.'}
    if (job.meta.hdr) return {block: true, note: 'This video is HDR. Sign in to render it on the server with correct colours.'}
    return {block: true, note: off.length === 3 ? 'This browser cannot encode video. Sign in to render on the server.' : `This browser cannot encode ${labelOf(draft.codec)}. Pick another codec or sign in.`}
  }
  if (job.tier === 'free' && (body.look || body.exposure)) return {block: true, note: `${body.look ? 'HDR' : 'Exposure'} only works in a render on this device. Turn it off to use the server.`}
  if (job.size > MAX_BYTES) return {block: true, note: 'The server takes files up to 2000 MB. This one is bigger.'}
  return {network: true, note: 'The server renders this one; the round arrives in your Telegram chat.'}
}
