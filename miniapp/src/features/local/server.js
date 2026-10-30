import {jobPath, post, request, respond} from '../../services/api.js'
import {droppedOf, freeOf} from './plan.js'

const ORACLE = '?via=oracle'
const LANES = 3
const TRIES = 3
const POLL = 2000
const SWITCH = 'The full version is unavailable right now, switching to the free server…'
const percent = new Intl.NumberFormat(undefined, {style: 'percent'})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const sendPart = async (path, body) => {
  for (let t = 1; ; t++) {
    try {return await request(path, {method: 'PUT', body})} catch (failure) {if (t >= TRIES) throw failure}
  }
}

const sendParts = async ({id, chunk}, file, via, onPart) => {
  const left = Array.from({length: Math.ceil(file.size / chunk)}, (_, k) => k)
  const total = left.length
  let done = 0
  const lane = async () => {
    for (let k = left.shift(); k !== undefined; k = left.shift()) {
      await sendPart(`${jobPath(id)}/parts/${k}${via}`, file.slice(k * chunk, (k + 1) * chunk))
      onPart(++done / total)
    }
  }
  await Promise.all(Array.from({length: LANES}, lane))
  return post(`${jobPath(id)}/uploaded${via}`)
}

// [DOC: local-server]
export const prepare = async (file, say, oracle = false) => {
  say('Uploading…')
  const {body: upload, via: answered} = await respond(`/api/uploads${oracle ? ORACLE : ''}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: file.name, size: file.size})})
  // [DOC: modal-fallback]
  const via = oracle || answered === 'oracle' ? ORACLE : ''
  await sendParts(upload, file, via, share => say(`Uploading… ${percent.format(share)}`))
  say('Preparing the video…')
  for (let job = await request(jobPath(upload.id) + via); ; job = await request(jobPath(upload.id) + via)) {
    if (job.status === 'ready') return {...job, oracle: Boolean(via)}
    if (job.status === 'failed') throw new Error(job.error || 'The server could not read this video')
    await sleep(POLL)
  }
}

// [DOC: modal-fallback]
export const renderOnServer = async (file, body, say, {id, oracle = false} = {}) => {
  try {
    const ready = id ? {id} : await prepare(file, say, oracle)
    const free = oracle || ready.oracle
    await post(`${jobPath(ready.id)}/render${free ? ORACLE : ''}`, free ? freeOf(body) : body)
    return {dropped: free && !oracle ? droppedOf(body) : []}
  } catch (failure) {
    if (oracle || failure.code !== 'pro_unavailable') throw failure
    say(SWITCH)
    await renderOnServer(file, body, say, {oracle: true})
    return {dropped: droppedOf(body)}
  }
}

export const sendNote = (blob, name) => request(`/api/notes?name=${encodeURIComponent(name)}`, {method: 'POST', headers: {'Content-Type': 'video/mp4'}, body: blob})
