import {tg} from '../../services/telegram.js'
import {BUILD, keep, recall, report} from '../../services/telemetry.js'

// [DOC: device-sample]
const KEY = 'rounds.device'
const SPIN = 5e6
const WINDOW = 1000
// [DOC: gpu-bench]
const BENCH = {n: 1024, tile: 16, reps: 8, rounds: 3}
const SHADER = `
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> c: array<f32>;
const N = ${BENCH.n}u;
const T = ${BENCH.tile}u;
var<workgroup> ta: array<f32, ${BENCH.tile ** 2}>;
var<workgroup> tb: array<f32, ${BENCH.tile ** 2}>;
@compute @workgroup_size(${BENCH.tile}, ${BENCH.tile})
fn main(@builtin(global_invocation_id) g: vec3u, @builtin(local_invocation_id) l: vec3u) {
  var sum = 0.0;
  for (var k = 0u; k < N; k += T) {
    ta[l.y * T + l.x] = a[g.y * N + k + l.x];
    tb[l.y * T + l.x] = b[(k + l.y) * N + g.x];
    workgroupBarrier();
    for (var i = 0u; i < T; i++) {sum += ta[l.y * T + i] * tb[i * T + l.x];}
    workgroupBarrier();
  }
  c[g.y * N + g.x] = sum;
}`

const since = t0 => performance.now() - t0
const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits

export const frameRate = () => new Promise(resolve => {
  const t0 = performance.now()
  let n = 0
  const tick = now => now - t0 < WINDOW ? (n++, requestAnimationFrame(tick)) : resolve(Math.round(n * 1000 / (now - t0)))
  requestAnimationFrame(tick)
})

// [DOC: device-conditions]
export const spin = (count = SPIN) => {
  const t0 = performance.now()
  let sum = 0
  for (let i = 0; i < count; i++) sum += Math.sqrt(i)
  return sum > 0 ? since(t0) : NaN
}

export const deviceOn = async () => {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null)
  return adapter && {adapter, device: await adapter.requestDevice()}
}

const limitsOf = limits => {
  const out = {}
  for (const key in limits) if (typeof limits[key] === 'number') out[key] = limits[key]
  return out
}

export const adapterInfo = async () => {
  if (!navigator.gpu) return {api: 'none'}
  const adapter = await navigator.gpu.requestAdapter().catch(() => null)
  if (!adapter) return {api: 'yes', adapter: 'none'}
  const device = await adapter.requestDevice().catch(error => error)
  const ok = typeof device?.destroy === 'function'
  if (ok) device.destroy()
  const {vendor, architecture, isFallbackAdapter} = adapter.info ?? {}
  return {api: 'yes', adapter: `${vendor || '?'} / ${architecture || '?'}`, fallback: Boolean(isFallbackAdapter), device: ok ? 'ok' : String(device?.message), limits: limitsOf(adapter.limits), features: [...adapter.features].sort()}
}

// [DOC: gpu-bench]
export const gpuBench = async () => {
  const found = await deviceOn().catch(() => null)
  if (!found) return null
  const {device} = found, {n, tile, reps, rounds} = BENCH
  try {
    const buffers = [0, 1, 2].map(() => device.createBuffer({size: n * n * 4, usage: GPUBufferUsage.STORAGE}))
    const pipeline = device.createComputePipeline({layout: 'auto', compute: {module: device.createShaderModule({code: SHADER}), entryPoint: 'main'}})
    const group = device.createBindGroup({layout: pipeline.getBindGroupLayout(0), entries: buffers.map((buffer, binding) => ({binding, resource: {buffer}}))})
    const submit = count => {
      const encoder = device.createCommandEncoder()
      for (let i = 0; i < count; i++) {const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(n / tile, n / tile); pass.end()}
      device.queue.submit([encoder.finish()])
      return device.queue.onSubmittedWorkDone()
    }
    let t0 = performance.now()
    await submit(1)
    const first = since(t0)
    let best = Infinity
    for (let r = 0; r < rounds; r++) {t0 = performance.now(); await submit(reps); best = Math.min(best, since(t0) / reps)}
    return {first: Math.round(first), matmul: round(best), gflops: Math.round(2 * n ** 3 / best / 1e6)}
  } finally {device.destroy()}
}

const signature = async () => ({
  platform: tg()?.platform ?? 'web', telegram: tg()?.version ?? null, agent: navigator.userAgent,
  cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory ?? null, screen: [screen.width, screen.height, devicePixelRatio],
  touch: matchMedia('(pointer: coarse)').matches, isolated: crossOriginIsolated, gpu: await adapterInfo(), bench: await gpuBench()
})

// [DOC: device-sample]
export const sampleDevice = async () => {
  const stamp = `${BUILD} ${tg()?.version ?? ''}`, saved = recall(KEY)
  const same = saved?.stamp === stamp, found = same ? saved.signature : await signature()
  const fps = await frameRate(), took = spin(), best = Math.min(took, saved?.best ?? Infinity)
  keep(KEY, {stamp, signature: found, best})
  report('device', {...found, cached: same})
  report('conditions', {fps, spin: round(took), best: round(best), ratio: round(took / best, 2), hidden: document.hidden})
}
