import {tg} from './telegram.js'

// [DOC: api-url]
export const API = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')
const NETWORK = 'No connection to the server. Check the network and try again.'

let authorization = () => `tma ${tg()?.initData}`

// [DOC: auth-header]
export const authorize = get => {authorization = get}

const messageOf = (status, detail) =>
  typeof detail === 'string' ? detail : detail?.[0]?.msg || `Request failed (${status})`

const request = async (path, init = {}) => {
  const headers = {...init.headers, Authorization: authorization()}
  const response = await fetch(API + path, {...init, headers}).catch(() => {throw new Error(NETWORK)})
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(messageOf(response.status, body.detail))
  return body
}

export const jobId = () => new URLSearchParams(location.search).get('job')
// [DOC: launch-aspect]
export const launchAspect = () => Number(new URLSearchParams(location.search).get('a')) || null

const jobPath = id => `/api/jobs/${encodeURIComponent(id)}`
export const post = (path, body) => request(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})

export const getJob = id => request(jobPath(id))

export const postRender = (id, body) => post(`${jobPath(id)}/render`, body)

// [DOC: lift]
export const warmLift = id => post(`${jobPath(id)}/warm`)

export const segment = (id, prompt) => post(`${jobPath(id)}/segment`, prompt)

// [DOC: follow]
export const track = (id, body) => post(`${jobPath(id)}/track`, body)

// [DOC: exact-frame]
export const lookFrame = (id, body) => post(`${jobPath(id)}/look`, body)

// [DOC: browser-upload]
const LANES = 3, TRIES = 3
export const startUpload = file => post('/api/uploads', {name: file.name, size: file.size})

const sendPart = async (path, body) => {
  for (let t = 1; ; t++) {
    try {return await request(path, {method: 'PUT', body})} catch (failure) {if (t >= TRIES) throw failure}
  }
}

export const sendParts = async ({id, chunk}, file, done, onPart) => {
  const left = Array.from({length: Math.ceil(file.size / chunk)}, (_, k) => k).filter(k => !done.has(k))
  const lane = async () => {
    for (let k = left.shift(); k !== undefined; k = left.shift()) {
      await sendPart(`${jobPath(id)}/parts/${k}`, file.slice(k * chunk, (k + 1) * chunk))
      done.add(k)
      onPart(done.size)
    }
  }
  await Promise.all(Array.from({length: LANES}, lane))
  return post(`${jobPath(id)}/uploaded`)
}
