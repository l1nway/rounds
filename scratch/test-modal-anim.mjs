import {spawn} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const html = `<!doctype html>
<html>
<head>
<style>
:root {
  --ease: cubic-bezier(0.2, 0.8, 0.2, 1);
  --stage: #1c1c1e;
  --bg: #000;
  --radius: 12px;
}
body {
  margin: 0;
  background: #f00;
  height: 100vh;
}
.content {
  font-size: 32px;
  padding: 40px;
}
@keyframes web-backdrop-enter {
  from {
    opacity: 0;
    backdrop-filter: blur(0px);
    -webkit-backdrop-filter: blur(0px);
  }
  to {
    opacity: 1;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
}
@keyframes enter {
  from {opacity: 0; filter: blur(10px); scale: 1.06}
}
@keyframes leave {
  to {opacity: 0; filter: blur(6px); scale: 0.9}
}
.web-backdrop {
  position: fixed;
  z-index: 30;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  background: color-mix(in srgb, var(--stage) 55%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  animation: web-backdrop-enter 300ms var(--ease);
  transition: opacity 300ms var(--ease), backdrop-filter 300ms var(--ease), -webkit-backdrop-filter 300ms var(--ease);
}
.web-backdrop[data-leaving] {
  opacity: 0;
  backdrop-filter: blur(0px);
  -webkit-backdrop-filter: blur(0px);
  pointer-events: none;
}
.web-card {
  width: 300px;
  padding: 20px;
  background: #fff;
  border-radius: var(--radius);
  animation: enter 300ms var(--ease);
}
.web-backdrop[data-leaving] .web-card {
  animation: leave 300ms var(--ease) forwards;
}
</style>
</head>
<body>
<div class="content">Background text behind modal</div>
<div id="root"></div>
</body>
</html>`

const srv = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end(html)
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port

const sleep = ms => new Promise(r => setTimeout(r, ms))
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const dir = mkdtempSync(join(tmpdir(), 'test-modal-'))
const proc = spawn(edge, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, `http://127.0.0.1:${port}/`], {stdio: 'ignore'})

let debugPort
for (let i = 0; i < 50; i++) {
  await sleep(100)
  try {
    debugPort = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim()
    if (debugPort) break
  } catch {}
}

const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent('http://127.0.0.1:' + port + '/')}`, {method: 'PUT'})).json()
const wsUrl = target.webSocketDebuggerUrl
const ws = new WebSocket(wsUrl)
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
await send('Page.navigate', {url: `http://127.0.0.1:${port}/`})
await sleep(500)
await send('Runtime.enable')

const evalCode = async expr => {
  const r = await send('Runtime.evaluate', {expression: expr, awaitPromise: true, returnByValue: true})
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

const result = await evalCode(`(async () => {
  const root = document.getElementById('root')
  root.innerHTML = '<div class="web-backdrop"><div class="web-card">Card</div></div>'
  const backdrop = root.querySelector('.web-backdrop')
  
  const snap1 = {
    opacity: getComputedStyle(backdrop).opacity,
    backdropFilter: getComputedStyle(backdrop).backdropFilter
  }
  
  await new Promise(r => setTimeout(r, 150))
  const snap2 = {
    opacity: getComputedStyle(backdrop).opacity,
    backdropFilter: getComputedStyle(backdrop).backdropFilter
  }
  
  await new Promise(r => setTimeout(r, 200))
  const snap3 = {
    opacity: getComputedStyle(backdrop).opacity,
    backdropFilter: getComputedStyle(backdrop).backdropFilter
  }

  // Now trigger leave
  backdrop.dataset.leaving = ''
  
  const anims = backdrop.getAnimations().map(a => ({
    type: a.constructor.name,
    playState: a.playState
  }))

  await new Promise(r => setTimeout(r, 150))
  const snap4 = {
    opacity: getComputedStyle(backdrop).opacity,
    backdropFilter: getComputedStyle(backdrop).backdropFilter
  }

  await new Promise(r => setTimeout(r, 200))
  const snap5 = {
    opacity: getComputedStyle(backdrop).opacity,
    backdropFilter: getComputedStyle(backdrop).backdropFilter,
    stillRunning: backdrop.getAnimations().filter(a => a.playState !== 'finished').length
  }

  return {snap1, snap2, snap3, anims, snap4, snap5}
})()`)

console.log('Result:', JSON.stringify(result, null, 2))

ws.close()
proc.kill()
srv.close()
await sleep(300)
try {rmSync(dir, {recursive: true, force: true})} catch {}
