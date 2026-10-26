import {tg} from './telegram.js'

// [DOC: api-url]
const API = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '')
const NETWORK = 'No connection to the server. Check the network and try again.'

const messageOf = (status, detail) =>
  typeof detail === 'string' ? detail : detail?.[0]?.msg || `Request failed (${status})`

const request = async (path, init = {}) => {
  const headers = {...init.headers, Authorization: `tma ${tg()?.initData}`}
  const response = await fetch(API + path, {...init, headers}).catch(() => {throw new Error(NETWORK)})
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(messageOf(response.status, body.detail))
  return body
}

export const jobId = () => new URLSearchParams(location.search).get('job')
// [DOC: launch-aspect]
export const launchAspect = () => Number(new URLSearchParams(location.search).get('a')) || null

const jobPath = id => `/api/jobs/${encodeURIComponent(id)}`
const post = (path, body) => request(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)})

export const getJob = id => request(jobPath(id))

export const postRender = (id, body) => post(`${jobPath(id)}/render`, body)

// [DOC: lift]
export const warmLift = id => post(`${jobPath(id)}/warm`)

export const segment = (id, prompt) => post(`${jobPath(id)}/segment`, prompt)
