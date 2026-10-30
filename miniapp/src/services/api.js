import {tg} from './telegram.js'

// [DOC: api-url]
export const API = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')
const NETWORK = 'No connection to the server. Check the network and try again.'

let authorization = () => `tma ${tg()?.initData}`

// [DOC: auth-header]
export const authorize = get => {authorization = get}

const messageOf = (status, detail) =>
  typeof detail === 'string' ? detail : detail?.[0]?.msg || `Request failed (${status})`

// [DOC: modal-fallback]
export const respond = async (path, init = {}) => {
  const headers = {...init.headers, Authorization: authorization()}
  const response = await fetch(API + path, {...init, headers}).catch(() => {throw new Error(NETWORK)})
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(messageOf(response.status, body.detail)), {status: response.status, code: body.code})
  return {body, via: response.headers.get('X-Rounds-Via')}
}

export const request = async (path, init) => (await respond(path, init)).body

export const jobId = () => new URLSearchParams(location.search).get('job')
// [DOC: launch-aspect]
export const launchAspect = () => Number(new URLSearchParams(location.search).get('a')) || null

export const jobPath = id => `/api/jobs/${encodeURIComponent(id)}`
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
