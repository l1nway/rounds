import {spawn} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer as createViteServer} from 'file:///C:/Users/l1nway/projects/l1nway%20rounds%20bot/miniapp/node_modules/vite/dist/node/index.js'

const vite = await createViteServer({
  root: 'C:/Users/l1nway/projects/l1nway rounds bot/miniapp',
  server: {port: 0, host: '127.0.0.1'},
  logLevel: 'silent'
})
await vite.listen()
const vitePort = vite.httpServer.address().port

const sleep = ms => new Promise(r => setTimeout(r, ms))
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const dir = mkdtempSync(join(tmpdir(), 'webapp-tap-'))
const proc = spawn(edge, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], {stdio: 'ignore'})

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
  if (m.method === 'Runtime.consoleAPICalled') console.log('BROWSER CONSOLE:', m.params.type, m.params.args.map(a => a.value || a.description).join(' '))
  if (m.method === 'Runtime.exceptionThrown') console.log('BROWSER EXCEPTION:', m.params.exceptionDetails)
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

const res = await evalCode(`(async () => {
  const web = document.querySelector('.web')
  if (!web) throw new Error('Web not found')

  // Load a video into file input
  const fileInput = document.querySelector('input[type="file"]')
  const videoBlob = await fetch('/__dev/media/proxy.mp4').then(r => r.blob())
  const file = new File([videoBlob], 'proxy.mp4', {type: 'video/mp4'})
  const dt = new DataTransfer()
  dt.items.add(file)
  fileInput.files = dt.files
  fileInput.dispatchEvent(new Event('change', {bubbles: true}))

  // Wait for video to load
  let video = null
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100))
    video = document.querySelector('.viewer-video')
    if (video && video.readyState >= 2) break
  }
  if (!video) throw new Error('Video not ready')

  // Now tap on the stage
  const stage = document.querySelector('.viewer-stage')
  if (!stage) throw new Error('Stage not found')

  const rect = stage.getBoundingClientRect()
  const clientX = rect.left + rect.width / 2
  const clientY = rect.top + rect.height / 2

  stage.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, clientX, clientY, pointerId: 1, isPrimary: true}))
  await new Promise(r => setTimeout(r, 50))
  stage.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, clientX, clientY, pointerId: 1, isPrimary: true}))

  await new Promise(r => setTimeout(r, 1000))
  const marks = document.querySelectorAll('.viewer-marks > *')
  const backdrop = document.querySelector('.web-backdrop')
  const card = document.querySelector('.web-card')

  const snapOpen = {
    marksCount: marks.length,
    hasBackdrop: Boolean(backdrop),
    cardText: card?.innerText,
    backdropOpacity: backdrop ? getComputedStyle(backdrop).opacity : null,
    backdropBlur: backdrop ? getComputedStyle(backdrop).backdropFilter : null
  }

  // Click "Download"
  const dlBtn = Array.from(card.querySelectorAll('button')).find(b => b.textContent.includes('Download'))
  dlBtn.click()

  await new Promise(r => setTimeout(r, 150))
  const snapLeaving = {
    stillMounted: Boolean(document.querySelector('.web-backdrop')),
    isLeaving: backdrop.hasAttribute('data-leaving'),
    opacity: getComputedStyle(backdrop).opacity,
    backdropFilter: getComputedStyle(backdrop).backdropFilter
  }

  await new Promise(r => setTimeout(r, 400))
  const syncElem = document.querySelector('.web-sync')
  const snapDownloading = {
    stillMounted: Boolean(document.querySelector('.web-backdrop')),
    syncText: syncElem?.innerText
  }

  return {snapOpen, snapLeaving, snapDownloading}
})()`)

console.log('Tap Result:', JSON.stringify(res, null, 2))

ws.close()
proc.kill()
await vite.close()
await sleep(300)
try {rmSync(dir, {recursive: true, force: true})} catch {}
