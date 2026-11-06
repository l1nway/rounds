import {tg} from '../../services/telegram.js'

// [DOC: device-check]
const SPIN = 2e7
const WINDOW = 1000
const LIFT_GROUP = 'lift'
const LIGHT = {group: 'light', names: ['vit-track'], seconds: 4, rate: 15, long: 640, box: [0.4, 0.4, 0.6, 0.6]}
const DECODERS = {hevc4k: 'hvc1.1.6.L153.B0', avc4k: 'avc1.640033'}
const LIMITS = ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup']
// [DOC: check-gpu-bench]
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
// [DOC: check-meter]
const METER = {step: 32, cap: 6144}

export const ms = value => `${Math.round(value)} ms`
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

const deviceOn = async () => {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null)
  return adapter && {adapter, device: await adapter.requestDevice()}
}

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

// [DOC: check-gpu-bench]
const gpuBench = async () => {
  const found = await deviceOn()
  if (!found) return {bench: 'no WebGPU'}
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
    return {first: ms(first), matmul: `${best.toFixed(1)} ms`, gflops: Math.round(2 * n ** 3 / best / 1e6)}
  } finally {device.destroy()}
}

const media = async () => {
  const [{canStabilize}, {encoders}] = await Promise.all([import('../local/gl.js'), import('../local/render.js')])
  const decoders = Object.fromEntries(await Promise.all(Object.entries(DECODERS).map(async ([key, codec]) => [key, await decodes(codec)])))
  return {webgl2Float: canStabilize(), encodeOff: (await encoders()).join(', ') || 'none', ...decoders}
}

const light = async job => {
  const {open} = await import('../local/render.js')
  const t0 = performance.now()
  const blob = await (await fetch(job.proxy_url)).blob()
  const fetched = since(t0), input = open(blob)
  try {return await lightOn(input, `${(blob.size / 1e6).toFixed(1)} MB, fetch ${ms(fetched)}`)} finally {input.dispose()}
}

const lightOn = async (input, got) => {
  const [{lightFrames}, {call, ready}] = await Promise.all([import('../local/light-frames.js'), import('../local/models.js')])
  const track = await input.getPrimaryVideoTrack()
  const [w, h, duration] = await Promise.all([track.getDisplayWidth(), track.getDisplayHeight(), input.computeDuration()])
  const k = LIGHT.long / Math.max(w, h), [width, height] = [Math.round(w * k), Math.round(h * k)]
  const t0 = performance.now()
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
    proxy: `${w}×${h}, ${got}`, backend: loaded.gpu ? 'webgpu' : 'wasm', load: ms(load), frames: steps,
    decodeFrame: ms(decode / steps), netStep: ms(net / steps), speed: `${(seconds / total * 1000).toFixed(2)}× real time`
  }
}

// [DOC: check-lift-settings]
const lift = cpu => async (job, note, {cache, runs, release: free}) => {
  const [{NAMES, segmentLocal}, {fast, ready, release}] = await Promise.all([import('../local/lift-local.js'), import('../local/models.js')])
  const source = {name: 'check', size: Date.now(), meta: job.meta}
  note('load')
  let t0 = performance.now()
  const {gpu: onGpu, reason} = await ready(LIFT_GROUP, NAMES, {cpu, cache})
  const out = {backend: onGpu ? 'webgpu' : 'wasm', cache: onGpu ? cache : '—', load: ms(since(t0)), ...reason && {gpuError: reason}}
  for (let i = 0; i < runs; i++) {
    note(`run ${i + 1}`)
    t0 = performance.now()
    await segmentLocal(source, {time: i, points: [[0.5, 0.5, 1]], box: null})
    out[`run${i + 1}`] = ms(since(t0))
  }
  out.fast = fast()
  if (free) {note('release'); release()}
  return out
}

// [DOC: check-meter]
const meter = async (job, note) => {
  const found = await deviceOn()
  if (!found) return {meter: 'no WebGPU'}
  const {adapter, device} = found, kept = [], size = Math.min(METER.step << 20, adapter.limits.maxBufferSize)
  let mb = 0, stop = 'cap'
  device.lost.then(info => {stop = `device lost: ${info.reason}`})
  while (mb < METER.cap && stop === 'cap') {
    device.pushErrorScope('out-of-memory')
    const buffer = device.createBuffer({size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST})
    const encoder = device.createCommandEncoder()
    encoder.clearBuffer(buffer)
    device.queue.submit([encoder.finish()])
    await device.queue.onSubmittedWorkDone()
    if (await device.popErrorScope()) {stop = 'out of memory'; break}
    kept.push(buffer)
    mb += size >> 20
    note(`${mb} MB`)
  }
  kept.forEach(buffer => buffer.destroy())
  device.destroy()
  return {reached: `${mb} MB`, stop}
}

export const PROBES = {
  env: () => ({
    telegram: `${tg()?.platform} ${tg()?.version}`, agent: navigator.userAgent, cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory ?? '—',
    screen: `${screen.width}×${screen.height} @${devicePixelRatio}`, touch: matchMedia('(pointer: coarse)').matches, isolated: crossOriginIsolated
  }),
  pace: async () => ({fps: await frameRate(), spin: ms(spin())}),
  webgpu: gpu,
  gpuBench,
  media,
  light,
  lift: lift(false),
  liftCpu: lift(true),
  meter
}
