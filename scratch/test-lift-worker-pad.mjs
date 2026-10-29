import {execFileSync, spawn} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const dir = mkdtempSync(join(tmpdir(), 'pad-diag-'))
const proc = spawn(edge, [
  '--headless=new',
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  '--remote-debugging-port=0',
  `--user-data-dir=${dir}`,
  'about:blank'
], {stdio: 'ignore'})

let port
for (let i = 0; i < 50; i++) {
  await sleep(100)
  try {
    port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim()
    if (port) break
  } catch {}
}

const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {method: 'PUT'})).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(r => {ws.onopen = r})

let msgId = 0
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const cur = ++msgId
  const h = e => {
    const m = JSON.parse(e.data)
    if (m.id === cur) {
      ws.removeEventListener('message', h)
      if (m.error) reject(new Error(m.error.message))
      else resolve(m.result)
    }
  }
  ws.addEventListener('message', h)
  ws.send(JSON.stringify({id: cur, method, params}))
})

ws.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args.map(a => a.value ?? a.description ?? JSON.stringify(a)).join(' ')
    console.log(`[PAGE LOG ${m.params.type}]:`, text)
  } else if (m.method === 'Runtime.exceptionThrown') {
    console.log('[PAGE EXCEPTION]:', m.params.exceptionDetails.text, m.params.exceptionDetails.exception?.description)
  }
})

await send('Page.enable')
await send('Runtime.enable')

await send('Page.navigate', {url: 'http://localhost:5173/'})
await sleep(1500)

const evalCode = async expr => {
  const r = await send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true})
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

console.log('Testing segmentLocal directly...')
const res = await evalCode(`(async () => {
  try {
    const {segmentLocal} = await import('/src/features/local/lift-local.js')
    const res = await fetch('/dev/media/proxy.mp4')
    const blob = await res.blob()
    const file = new File([blob], 'proxy.mp4', {type: 'video/mp4'})
    const job = {file, name: 'proxy.mp4', size: file.size, meta: {width: 960, height: 540}}
    console.log('Calling segmentLocal with 1 point...')
    const out = await segmentLocal(job, {
      time: 0, points: [[0.5, 0.5, 1]], box: null
    }, {
      confirm: () => true,
      onProgress: p => console.log('Progress:', p)
    })
    console.log('segmentLocal out:', out ? {candidates: out.candidates.length, best: out.best} : null)
    return {ok: true, candidates: out.candidates.length}
  } catch (e) {
    console.error('segmentLocal failed:', e.message, e.stack)
    return {error: e.message, stack: e.stack}
  }
})()`)
console.log('Result:', res)

ws.close()
proc.kill()
await sleep(300)
try {rmSync(dir, {recursive: true, force: true})} catch {}

