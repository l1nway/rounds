import {spawn} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer as createViteServer} from 'file:///C:/Users/l1nway/projects/l1nway%20rounds%20bot/miniapp/node_modules/vite/dist/node/index.js'

console.log('Starting Vite server...')
const vite = await createViteServer({
  root: 'C:/Users/l1nway/projects/l1nway rounds bot/miniapp',
  server: {port: 0, host: '127.0.0.1'},
  logLevel: 'silent'
})
await vite.listen()
const vitePort = vite.httpServer.address().port
console.log('Vite listening on port', vitePort)

const sleep = ms => new Promise(r => setTimeout(r, ms))
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const dir = mkdtempSync(join(tmpdir(), 'track-e2e-'))
const proc = spawn(edge, [
  '--headless=new',
  '--remote-debugging-port=0',
  '--enable-unsafe-webgpu',
  '--use-webgpu-adapter=dedicated',
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
console.log('DevTools port:', port)

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

await send('Page.enable')
await send('Page.navigate', {url: `http://localhost:${vitePort}/`})
await sleep(1500)
await send('Runtime.enable')

const evalCode = async expr => {
  const r = await send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true})
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

console.log('Pre-seeding Cache API with SAM2 video tracker ONNX models...')
const V_BASE = 'https://huggingface.co/diffusionstudio/sam2.1-tiny-video-onnx-fp16/resolve/66673b5db39371b7dd7847f4d3bc0d4f4179b79e'
const files = [
  {url: `${V_BASE}/vision_encoder.onnx`, path: 'C:/Users/l1nway/projects/l1nway rounds bot/miniapp/dev/sam2-video-fp16/vision_encoder.onnx'},
  {url: `${V_BASE}/mask_decoder.onnx`, path: 'C:/Users/l1nway/projects/l1nway rounds bot/miniapp/dev/sam2-video-fp16/mask_decoder.onnx'},
  {url: `${V_BASE}/memory_attention.onnx`, path: 'C:/Users/l1nway/projects/l1nway rounds bot/miniapp/dev/sam2-video-fp16/memory_attention.onnx'},
  {url: `${V_BASE}/memory_encoder.onnx`, path: 'C:/Users/l1nway/projects/l1nway rounds bot/miniapp/dev/sam2-video-fp16/memory_encoder.onnx'},
  {url: `${V_BASE}/pointer_tpos.onnx`, path: 'C:/Users/l1nway/projects/l1nway rounds bot/miniapp/dev/sam2-video-fp16/pointer_tpos.onnx'}
]

for (const {url, path} of files) {
  const buf = readFileSync(path)
  const b64 = buf.toString('base64')
  console.log('Caching', url.split('/').pop(), `(${buf.byteLength} bytes)...`)
  await evalCode(`(async () => {
    const cache = await caches.open('rounds-models-v1')
    const bin = atob("${b64}")
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    await cache.put("${url}", new Response(u8.buffer, {headers: {'content-type': 'application/octet-stream'}}))
  })()`)
}
console.log('All models cached successfully in browser Cache API!')

console.log('Running e2e test in Edge...')
const testResult = await evalCode(`(async () => {
  const results = {logs: []}
  const log = msg => {console.log(msg); results.logs.push(String(msg))}

  log('Fetching test proxy.mp4...')
  const resp = await fetch('/dev/media/proxy.mp4')
  const blob = await resp.blob()
  const file = new File([blob], 'proxy.mp4', {type: 'video/mp4'})

  log('Probing video with probe.js...')
  const {probe} = await import('/src/features/local/probe.js')
  const probed = await probe(file)
  const source = {...probed, file, size: file.size, name: file.name}
  log('Probed: ' + source.meta.width + 'x' + source.meta.height + ', duration: ' + source.meta.duration)

  log('Testing followLocal (preview tracking)...')
  const {followLocal} = await import('/src/features/local/track-local.js')
  const t0 = performance.now()
  const followRes = await followLocal(source, {
    start: 0, end: 1.5,
    prompt: {time: 0.5, points: [[0.5, 0.5, 1]], box: null}
  })
  const followDuration = performance.now() - t0
  log('followLocal returned in ' + Math.round(followDuration) + 'ms')
  log('followRes fps: ' + followRes?.fps + ', start: ' + followRes?.start + ', boxes count: ' + followRes?.boxes?.length)
  results.follow = {
    duration: Math.round(followDuration),
    fps: followRes?.fps,
    start: followRes?.start,
    boxesCount: followRes?.boxes?.length,
    firstBox: followRes?.boxes?.[0],
    seedBox: followRes?.boxes?.[Math.round(0.5 * (followRes?.fps || 10))]
  }

  log('Testing renderNote with tracking...')
  const {renderNote} = await import('/src/features/local/render.js')
  const t1 = performance.now()
  const progressList = []
  const renderRes = await renderNote(file, source.meta, {
    start: 0, end: 1.5, codec: 'hevc',
    prompt: {time: 0.5, points: [[0.5, 0.5, 1]], box: null},
    options: {zoom: false},
    denoise: 0, look: 0, exposure: 0
  }, p => progressList.push(Math.round(p * 100)))
  const renderDuration = performance.now() - t1
  log('renderNote returned in ' + Math.round(renderDuration) + 'ms')
  log('Rendered blob size: ' + renderRes?.blob?.size + ', type: ' + renderRes?.blob?.type)
  results.render = {
    duration: Math.round(renderDuration),
    blobSize: renderRes?.blob?.size,
    blobType: renderRes?.blob?.type,
    progressCount: progressList.length
  }

  return results
})()`)

console.log('\n=== TEST RESULTS ===')
console.log(JSON.stringify(testResult, null, 2))

ws.close()
proc.kill()
try {rmSync(dir, {recursive: true, force: true})} catch {}
await vite.close()
