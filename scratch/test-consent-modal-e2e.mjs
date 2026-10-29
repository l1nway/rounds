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
const dir = mkdtempSync(join(tmpdir(), 'consent-modal-'))
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

await send('Page.enable')
await send('Page.navigate', {url: `http://localhost:${vitePort}/`})
await sleep(1200)
await send('Runtime.enable')

const evalCode = async expr => {
  const r = await send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true})
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

const testRes = await evalCode(`(async () => {
  // Check if WebApp loaded
  const web = document.querySelector('.web')
  if (!web) throw new Error('WebApp (.web) not found: ' + document.body.innerHTML.slice(0, 200))

  // Dynamically test mounting the Result component inside the existing Preact environment
  const {createRoot} = await import('/node_modules/.vite/deps/react-dom_client.js')
  const {createElement: h} = await import('/node_modules/.vite/deps/react.js')
  const {default: Result} = await import('/src/features/web/result.jsx')

  const testHost = document.createElement('div')
  document.body.appendChild(testHost)
  const root = createRoot(testHost)

  let resolvedWith = null
  const consent = {
    bytes: 76068699,
    resolve: val => {resolvedWith = val}
  }

  // 1. Mount Result with consent
  root.render(h(Result, {consent}))
  await new Promise(r => setTimeout(r, 20))

  const backdrop = document.querySelector('.web-backdrop')
  const card = document.querySelector('.web-card')
  if (!backdrop) throw new Error('Backdrop not mounted')

  const enterSnap0 = {
    mounted: true,
    opacity: getComputedStyle(backdrop).opacity,
    backdropFilter: getComputedStyle(backdrop).backdropFilter
  }

  await new Promise(r => setTimeout(r, 150))
  const enterSnap150 = {
    opacity: getComputedStyle(backdrop).opacity,
    backdropFilter: getComputedStyle(backdrop).backdropFilter
  }

  await new Promise(r => setTimeout(r, 200))
  const enterSnapFinal = {
    opacity: getComputedStyle(backdrop).opacity,
    backdropFilter: getComputedStyle(backdrop).backdropFilter
  }

  // 2. Click "Not now" button
  const notNowBtn = Array.from(card.querySelectorAll('button')).find(b => b.textContent.includes('Not now'))
  if (!notNowBtn) throw new Error('Not now button not found')
  notNowBtn.click()

  // 3. Re-render Result with consent: null (simulating WebApp dispatch({consent: null}))
  root.render(h(Result, {consent: null}))
  await new Promise(r => setTimeout(r, 20))

  const leaveSnap0 = {
    stillMounted: Boolean(document.querySelector('.web-backdrop')),
    isLeaving: backdrop.hasAttribute('data-leaving'),
    pointerEvents: getComputedStyle(backdrop).pointerEvents,
    opacity: getComputedStyle(backdrop).opacity,
    backdropFilter: getComputedStyle(backdrop).backdropFilter
  }

  await new Promise(r => setTimeout(r, 150))
  const leaveSnap150 = {
    stillMounted: Boolean(document.querySelector('.web-backdrop')),
    opacity: getComputedStyle(backdrop).opacity,
    backdropFilter: getComputedStyle(backdrop).backdropFilter
  }

  await new Promise(r => setTimeout(r, 250))
  const leaveSnapFinal = {
    stillMounted: Boolean(document.querySelector('.web-backdrop')),
    resolvedWith
  }

  return {enterSnap0, enterSnap150, enterSnapFinal, leaveSnap0, leaveSnap150, leaveSnapFinal}
})()`)

console.log('E2E Result:', JSON.stringify(testRes, null, 2))

ws.close()
proc.kill()
await vite.close()
await sleep(300)
try {rmSync(dir, {recursive: true, force: true})} catch {}
