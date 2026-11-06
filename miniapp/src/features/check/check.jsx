import {useEffect, useRef, useState} from 'react'
import {tg} from '../../services/telegram.js'
import './check.css'

// [DOC: device-check]
const STEP = 'rounds.check-step'
const SPIN = 2e7
const WINDOW = 1000
const LIFTS = 3
const LIFT_GROUP = 'lift'
const LIGHT = {group: 'light', names: ['vit-track'], seconds: 4, rate: 15, long: 640, box: [0.4, 0.4, 0.6, 0.6]}
const DECODERS = {hevc4k: 'hvc1.1.6.L153.B0', avc4k: 'avc1.640033'}
const LIMITS = ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup']

const store = () => {try {return localStorage} catch {return null}}
const ms = value => `${Math.round(value)} ms`
const since = t0 => performance.now() - t0

const frameRate = () => new Promise(resolve => {
  const t0 = performance.now()
  let n = 0
  const tick = now => now - t0 < WINDOW ? (n++, requestAnimationFrame(tick)) : resolve(Math.round(n * 1000 / (now - t0)))
  requestAnimationFrame(tick)
})

const spin = () => {
  const t0 = performance.now()
  let sum = 0
  for (let i = 0; i < SPIN; i++) sum += Math.sqrt(i)
  return sum > 0 ? since(t0) : NaN
}

const decodes = async codec => typeof VideoDecoder === 'function'
  && Boolean((await VideoDecoder.isConfigSupported({codec, codedWidth: 3840, codedHeight: 2160}).catch(() => null))?.supported)

const gpu = async () => {
  if (!navigator.gpu) return {api: 'none'}
  const adapter = await navigator.gpu.requestAdapter().catch(() => null)
  if (!adapter) return {api: 'yes', adapter: 'none'}
  const device = await adapter.requestDevice().catch(error => error)
  const ok = typeof device?.destroy === 'function'
  if (ok) device.destroy()
  const {vendor, architecture, isFallbackAdapter} = adapter.info ?? {}
  return {adapter: `${vendor || '?'} / ${architecture || '?'}`, fallback: Boolean(isFallbackAdapter), device: ok ? 'ok' : device?.message, ...Object.fromEntries(LIMITS.map(key => [key, adapter.limits[key]]))}
}

const media = async () => {
  const [{canStabilize}, {encoders}] = await Promise.all([import('../local/gl.js'), import('../local/render.js')])
  const decoders = Object.fromEntries(await Promise.all(Object.entries(DECODERS).map(async ([key, codec]) => [key, await decodes(codec)])))
  return {webgl2Float: canStabilize(), encodeOff: (await encoders()).join(', ') || 'none', ...decoders}
}

const light = async job => {
  const [{open}, {lightFrames}, {call, ready}] = await Promise.all([import('../local/render.js'), import('../local/light-frames.js'), import('../local/models.js')])
  let t0 = performance.now()
  const blob = await (await fetch(job.proxy_url)).blob()
  const fetched = since(t0), input = open(blob), track = await input.getPrimaryVideoTrack()
  const [w, h, duration] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight(), input.computeDuration()])
  const k = LIGHT.long / Math.max(w, h), [width, height] = [Math.round(w * k), Math.round(h * k)]
  t0 = performance.now()
  const loaded = await ready(LIGHT.group, LIGHT.names, {cpu: true})
  const load = since(t0), seconds = Math.min(LIGHT.seconds, duration)
  const times = Array.from({length: Math.floor(seconds * LIGHT.rate)}, (_, i) => i / LIGHT.rate)
  let decode = 0, net = 0, steps = 0, mark = performance.now()
  const start = mark
  for await (const rgba of lightFrames(track, width, height)(times)) {
    const at = performance.now(), {buffer} = rgba ?? new Uint8ClampedArray(width * height * 4)
    decode += at - mark
    await call({group: LIGHT.group, type: steps ? 'step' : 'seed', rgba: buffer, width, height, prompt: {box: LIGHT.box, points: []}}, [buffer])
    mark = performance.now()
    net += mark - at
    steps++
  }
  await call({group: LIGHT.group, type: 'reset'})
  const total = since(start)
  return {
    proxy: `${w}×${h}, ${(blob.size / 1e6).toFixed(1)} MB, fetch ${ms(fetched)}`, backend: loaded.gpu ? 'webgpu' : 'wasm', load: ms(load), frames: steps,
    decodeFrame: ms(decode / steps), netStep: ms(net / steps), speed: `${(seconds / total * 1000).toFixed(2)}× real time`
  }
}

const lift = async job => {
  const [{segmentLocal}, {fast, ready, release}] = await Promise.all([import('../local/lift-local.js'), import('../local/models.js')])
  const source = {name: 'check', size: Date.now(), meta: job.meta}, out = {}
  for (let i = 0; i < LIFTS; i++) {
    const t0 = performance.now()
    await segmentLocal(source, {time: i, points: [[0.5, 0.5, 1]], box: null}, i ? {} : {onLoaded: () => {out.load = ms(since(t0))}})
    out[`run${i + 1}`] = ms(since(t0))
  }
  const {gpu: onGpu, reason} = await ready(LIFT_GROUP, [])
  release()
  return {...out, backend: onGpu ? 'webgpu' : 'wasm', ...reason && {gpuError: reason}, fast: fast()}
}

const STEPS = [
  ['env', () => ({
    telegram: `${tg()?.platform} ${tg()?.version}`, agent: navigator.userAgent, cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory ?? '—',
    screen: `${screen.width}×${screen.height} @${devicePixelRatio}`, touch: matchMedia('(pointer: coarse)').matches, isolated: crossOriginIsolated
  })],
  ['pace', async () => ({fps: await frameRate(), spin: ms(spin())})],
  ['webgpu', gpu],
  ['media', media],
  ['light', light],
  ['lift', lift]
]

const linesOf = (name, result) => Object.entries(result).map(([key, value]) => `${name}.${key}: ${value}`)

// [DOC: device-check]
export default function Check({job}) {
  const [lines, setLines] = useState(() => [store()?.getItem(STEP)].filter(Boolean).map(died => `previous run stopped during: ${died}`))
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const pre = useRef(null)
  const lock = useRef(false)

  useEffect(() => {store()?.removeItem(STEP)}, [])

  const run = async () => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setCopied('')
    const out = [`date: ${new Date().toISOString()}`]
    setLines(out)
    for (const [name, probe] of STEPS) {
      store()?.setItem(STEP, name)
      const t0 = performance.now()
      try {out.push(...linesOf(name, await probe(job)), `${name}.took: ${ms(since(t0))}`)} catch (error) {out.push(`${name}: failed: ${error?.message || error}`)}
      setLines([...out])
    }
    store()?.removeItem(STEP)
    lock.current = false
    setBusy(false)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied('Copied')
    } catch {
      getSelection()?.selectAllChildren(pre.current)
      setCopied('Selected: copy it from the menu')
    }
  }

  return (
    <details className='check'>
      <summary>Device check</summary>
      <p className='check-note'>Measures this device for local processing. It downloads the models once: about 40 MB on a phone.</p>
      <div className='check-actions'>
        <button type='button' onClick={run} disabled={busy} aria-busy={busy || undefined}>{busy ? 'Checking…' : 'Run check'}</button>
        <button type='button' onClick={copy} disabled={busy || !lines.length}>Copy report</button>
      </div>
      <p className='check-note' aria-live='polite'>{copied}</p>
      {lines.length > 0 && <pre ref={pre}>{lines.join('\n')}</pre>}
    </details>
  )
}
