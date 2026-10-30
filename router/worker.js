// [DOC: router]
const INIT_DATA_TTL = 24 * 3600
const FILE = /^\/api\/jobs\/[\w-]+\/[\w.-]+$/
const TIERS = [['pro', true], ['free', false]]
// [DOC: modal-fallback]
const JOB = /^\/api\/jobs\/[\w-]+(\/|$)/
const GPU = /^\/api\/jobs\/[\w-]+\/(segment|track|look)$/
const WAIT = 45_000
const DOWN_FOR = 180_000
const BUFFER = 16 << 20
const MARK = 'x-rounds-origin'
const VIA = 'X-Rounds-Via'
const UNAVAILABLE = {code: 'pro_unavailable', detail: 'The full version is unavailable right now, try again in a few minutes'}
const enc = new TextEncoder()
let downUntil = 0

const hmac = async (key, data) => {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)))
}
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
const same = (a, b) => {
  const [x, y] = [enc.encode(a), enc.encode(b)]
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y)
}
// [DOC: router-secrets]
const secret = (env, label) => hmac(label, env.TELEGRAM_BOT_TOKEN.trim())
const allowed = (env, id) => env.ALLOWED_USER_IDS.replace(/\s/g, '').split(',').includes(String(id))

// [DOC: router-auth]
const fromInitData = async (env, data) => {
  const fields = new URLSearchParams(data)
  const check = [...fields].filter(([k]) => k !== 'hash').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n')
  const fresh = Date.now() / 1000 - Number(fields.get('auth_date')) <= INIT_DATA_TTL
  const signed = same(hex(await hmac(await secret(env, 'WebAppData'), check)), fields.get('hash') ?? '')
  return signed && fresh ? JSON.parse(fields.get('user') ?? '{}').id : null
}

const fromSession = async (env, token) => {
  const at = token.lastIndexOf('.')
  const payload = token.slice(0, at), [id, exp] = payload.split('.')
  const signed = same(hex(await hmac(await secret(env, 'Session'), payload)), token.slice(at + 1))
  return signed && Number(exp) > Date.now() / 1000 ? Number(id) : null
}

const userOf = (env, authorization) => {
  const [kind, ...rest] = authorization.split(' ')
  const value = rest.join(' ')
  return kind === 'web' ? fromSession(env, value) : kind === 'tma' ? fromInitData(env, value) : null
}

// [DOC: router-files]
const fileTier = async (env, path, query) => {
  const [, , , id, name] = path.split('/')
  const exp = query.get('exp') ?? '', sig = query.get('sig') ?? ''
  if (!(Number(exp) > Date.now() / 1000)) return null
  for (const [tier, pro] of TIERS) {
    if (same(hex(await hmac(await secret(env, `Files.${tier}`), `${id}:${name}:${exp}`)), sig)) return pro
  }
  return null
}

const forward = (request, env, pro, body = request.body, signal) => {
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  headers.set('x-rounds-base', url.origin)
  headers.delete('Modal-Key')
  headers.delete('Modal-Secret')
  if (pro) {
    headers.set('Modal-Key', env.MODAL_KEY.trim())
    headers.set('Modal-Secret', env.MODAL_SECRET.trim())
  }
  const target = new URL(url.pathname + url.search, pro ? env.MODAL_URL : env.ORACLE_URL)
  return fetch(target, {method: request.method, headers, body, redirect: 'manual', signal})
}

// [DOC: modal-fallback]
const relabel = (response, set = {}) => {
  const out = new Response(response.body, response)
  out.headers.delete(MARK)
  for (const [k, v] of Object.entries(set)) out.headers.set(k, v)
  return out
}
const viaOracle = response => relabel(response, {[VIA]: 'oracle', 'Access-Control-Expose-Headers': VIA})
const unavailable = request => Response.json(UNAVAILABLE, {status: 503, headers: {
  'Retry-After': String(DOWN_FOR / 1000), [VIA]: 'none', 'Access-Control-Allow-Origin': request.headers.get('Origin') ?? '*',
  'Access-Control-Expose-Headers': `${VIA}, Retry-After`
}})

const buffered = async request => {
  const size = Number(request.headers.get('content-length') ?? NaN)
  return request.body === null ? [null, true] : size <= BUFFER ? [await request.arrayBuffer(), true] : [request.body, false]
}

const tryModal = async (request, env, body, wait) => {
  if (Date.now() < downUntil) return null
  const abort = new AbortController()
  const timer = wait && setTimeout(() => abort.abort(new Error(`no answer in ${wait} ms`)), wait)
  try {
    const response = await forward(request, env, true, body, abort.signal)
    if (response.headers.has(MARK) || response.status < 400) return response
    console.log('modal refused', response.status, await response.text())
  } catch (error) {
    console.log('modal failed', String(error))
  } finally {
    clearTimeout(timer)
  }
  downUntil = Date.now() + DOWN_FOR
  return null
}

const toPro = async (request, env, body = request.body, replay = false) => {
  const {pathname} = new URL(request.url)
  const job = JOB.test(pathname)
  const modal = await tryModal(request, env, body, replay && !GPU.test(pathname) ? WAIT : 0)
  if (modal && !(job && replay && modal.status === 404)) return relabel(modal)
  if (!replay) return unavailable(request)
  await modal?.body?.cancel()
  const oracle = await forward(request, env, false, body).catch(error => console.log('oracle failed', String(error)))
  if (!oracle || (job && oracle.status === 404 && !modal)) return unavailable(request)
  return job && oracle.status === 404 ? relabel(oracle) : viaOracle(oracle)
}

const webhook = async (request, env) => {
  if (!same(request.headers.get('X-Telegram-Bot-Api-Secret-Token') ?? '', env.TELEGRAM_WEBHOOK_SECRET.trim())) return new Response(null, {status: 403})
  const text = await request.text()
  const update = JSON.parse(text)
  const id = (update.message ?? update.callback_query)?.from?.id
  return allowed(env, id) ? toPro(request, env, text, true) : forward(request, env, false, text)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === '/telegram/webhook' && request.method === 'POST') return webhook(request, env)
    if (!url.pathname.startsWith('/api/')) return new Response(null, {status: 404})
    if (request.method === 'GET' && FILE.test(url.pathname)) {
      const pro = await fileTier(env, url.pathname, url.searchParams)
      return pro === null ? new Response(null, {status: 403}) : pro ? toPro(request, env) : forward(request, env, false)
    }
    const id = request.method === 'OPTIONS' ? null : await userOf(env, request.headers.get('Authorization') ?? '')
    const pro = id != null && allowed(env, id) && url.searchParams.get('via') !== 'oracle'
    return pro ? toPro(request, env, ...await buffered(request)) : forward(request, env, false)
  }
}
