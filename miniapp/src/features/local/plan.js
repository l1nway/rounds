import {CODECS, LEVELS, OPTIONS, levelsFor, optionsFor} from '../editor/draft.js'

const MAX_BYTES = 2000 * 1024 * 1024
const LOCAL_OPTIONS = new Set(['zoom', 'loudnorm', 'denoise', 'look', 'exposure', 'metadata'])
const need = key => [...OPTIONS, ...LEVELS].find(item => item.key === key).need
const labelOf = key => CODECS.find(codec => codec.key === key).label
const picked = ({box, points, crop}) => Boolean(box && !crop) || points.some(point => point[2] === 1)
// [DOC: stage-routing]
const ROUTE = ['gpu', 'oracle', 'cpu', 'modal']
export const STAGES = {stabilize: {gpu: true, oracle: false, cpu: true, modal: true}}
export const routeOf = (stage, job) => {
  const can = {gpu: Boolean(job.gpu), oracle: true, cpu: true, modal: job.tier === 'pro'}
  return ROUTE.find(where => STAGES[stage]?.[where] && can[where]) ?? null
}
const onDevice = (key, job) => ['gpu', 'cpu'].includes(routeOf(key, job))
const localLevel = ({key, local}, body, job) => onDevice(key, job) || LOCAL_OPTIONS.has(key) && (!(local < 1) || body[key] <= local)

// [DOC: modal-fallback]
const proOnly = [...OPTIONS, ...LEVELS].filter(item => item.need === 'pro' || STAGES[item.key]?.oracle === false)
export const freeOf = body => ({
  ...body,
  options: Object.fromEntries(Object.entries(body.options).map(([key, on]) => [key, on && need(key) !== 'pro'])),
  ...Object.fromEntries(proOnly.filter(item => item.key in body).map(item => [item.key, 0]))
})
export const droppedOf = body => [
  ...picked(body.prompt) ? ['following the object'] : [],
  ...proOnly.filter(item => body.options[item.key] || body[item.key]).map(item => item.label)
]

// [DOC: local-plan]
export const needsServer = (body, job) =>
  Object.entries(body.options).some(([key, on]) => on && !LOCAL_OPTIONS.has(key)) || LEVELS.some(level => body[level.key] && !localLevel(level, body, job))
  || job.meta.off.includes(body.codec) || Boolean(job.meta.hdr)

// [DOC: local-modal]
export const needsModal = (body, job) => job.tier === 'pro' && (picked(body.prompt)
  || Object.entries(body.options).some(([key, on]) => on && need(key) === 'pro')
  || LEVELS.some(level => body[level.key] && !localLevel(level, body, job) && (level.need === 'pro' || routeOf(level.key, job) === 'modal')))

export const gate = (draft, job) => {
  if (!job) return {network: true}
  const off = job.meta.off
  const body = {options: optionsFor(job, draft.options), prompt: draft, codec: draft.codec, ...levelsFor(job, draft)}
  if (!needsServer(body, job)) return {network: false}
  if (job.tier === 'local') {
    if (body.stabilize && !onDevice('stabilize', job)) return {block: true, note: 'Stabilize does not run in the browser yet. Turn it off to render here.'}
    if (job.meta.hdr) return {block: true, note: 'This video is HDR. Sign in to render it on the server with correct colours.'}
    return {block: true, note: off.length === 3 ? 'This browser cannot encode video. Sign in to render on the server.' : `This browser cannot encode ${labelOf(draft.codec)}. Pick another codec or sign in.`}
  }
  if (job.size > MAX_BYTES) return {block: true, note: 'The server takes files up to 2000 MB. This one is bigger.'}
  return {network: true, note: 'The server renders this one; the round arrives in your Telegram chat.'}
}
