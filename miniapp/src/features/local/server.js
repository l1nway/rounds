import {jobPath, post, request} from '../../services/api.js'

const ORACLE = '?via=oracle'
const LANES = 3
const TRIES = 3
const POLL = 2000
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
  const via = oracle ? ORACLE : ''
  say('Uploading…')
  const upload = await post(`/api/uploads${via}`, {name: file.name, size: file.size})
  await sendParts(upload, file, via, share => say(`Uploading… ${percent.format(share)}`))
  say('Preparing the video…')
  for (let job = await request(jobPath(upload.id) + via); ; job = await request(jobPath(upload.id) + via)) {
    if (job.status === 'ready') return job
    if (job.status === 'failed') throw new Error(job.error || 'The server could not read this video')
    await sleep(POLL)
  }
}

export const renderOnServer = async (file, body, say, {id, oracle = false} = {}) => {
  const ready = id ? {id} : await prepare(file, say, oracle)
  await post(`${jobPath(ready.id)}/render${oracle ? ORACLE : ''}`, body)
}

export const sendNote = (blob, name) => request(`/api/notes?name=${encodeURIComponent(name)}`, {method: 'POST', headers: {'Content-Type': 'video/mp4'}, body: blob})
