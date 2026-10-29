const CACHE = 'rounds-models-v1'
const REV = 'b3234dc2bf3cfd9475755d20a5dd11308c56e6ae'
const BASE = `https://huggingface.co/Geo-IA/evo-sam2.1-onnx/resolve/${REV}/sam2.1_hiera_tiny`
const V_REV = '66673b5db39371b7dd7847f4d3bc0d4f4179b79e'
const V_BASE = `https://huggingface.co/diffusionstudio/sam2.1-tiny-video-onnx-fp16/resolve/${V_REV}/onnx`

// [DOC: local-models]
export const MODELS = {
  'sam2.1-tiny-encoder': {
    name: 'sam2.1-tiny-encoder',
    url: `${BASE}/vision_encoder_fp16.onnx`,
    bytes: 67_313_499,
    sha256: 'f4ca896cf99816ad0cb7062e9ebef44a211e6f0d0a0656a7eb13349204cb6caa'
  },
  'sam2.1-tiny-decoder': {
    name: 'sam2.1-tiny-decoder',
    url: `${BASE}/prompt_encoder_mask_decoder_fp16.onnx`,
    bytes: 8_755_200,
    sha256: 'f362ed5bbcfbece283ce970a2162486da9f018645a382b927755677b9d267e6d'
  },
  'sam2.1-video-encoder': {
    name: 'sam2.1-video-encoder',
    url: `${V_BASE}/vision_encoder.onnx`,
    bytes: 58_385_353,
    sha256: '24e9ccf5994be5c8dd93ebe771a4cc4f8bb122d0524555ac3ba4e7141710b133'
  },
  'sam2.1-video-decoder': {
    name: 'sam2.1-video-decoder',
    url: `${V_BASE}/mask_decoder.onnx`,
    bytes: 8_898_805,
    sha256: '6bc158b0d028777ca2e25203ece0f27429c436de39a5c7fe301b3858d6059789'
  },
  'sam2.1-video-mem-attn': {
    name: 'sam2.1-video-mem-attn',
    url: `${V_BASE}/memory_attention.onnx`,
    bytes: 13_029_470,
    sha256: '67c4e4da01bc7f501b88294bb19a8200362915ece04e9d7e367a437658f342c9'
  },
  'sam2.1-video-mem-enc': {
    name: 'sam2.1-video-mem-enc',
    url: `${V_BASE}/memory_encoder.onnx`,
    bytes: 2_807_753,
    sha256: '8b2bb6810444cee684ef938b7464c5645653f236014f5497c3db3654818cc7ce'
  },
  'sam2.1-video-pointer': {
    name: 'sam2.1-video-pointer',
    url: `${V_BASE}/pointer_tpos.onnx`,
    bytes: 34_228,
    sha256: '3ab5bfce40ed01208301b2d8f596b9c9f7f493dcd7e09ef01ec22e5be3694bd7'
  }
}

let device = null
let consentHook = null
let progressHook = null
let approved = false
let inflight = null
const memory = new Map()

export const setModelConsent = fn => {consentHook = fn}
export const setModelProgress = fn => {progressHook = fn}

// [DOC: local-device]
export const deviceOf = () => device ??= (async () => {
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null)
  return {gpu: Boolean(adapter && !adapter.info?.isFallbackAdapter), wasm: typeof WebAssembly === 'object'}
})()

const openCache = () => typeof caches === 'object' ? caches.open(CACHE).catch(() => null) : Promise.resolve(null)
const hexOf = buffer => Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('')
const verify = async (buffer, expected) => hexOf(await crypto.subtle.digest('SHA-256', buffer)) === expected

const readCached = async (cache, item) => {
  if (memory.has(item.name)) return memory.get(item.name).slice(0)
  const res = await cache?.match(item.url).catch(() => null)
  if (!res) return null
  const buf = await res.arrayBuffer()
  if (buf.byteLength === item.bytes) return buf
  await cache.delete(item.url).catch(() => {})
  return null
}

export const hasModels = async names => {
  const cache = await openCache()
  const found = await Promise.all(names.map(name => readCached(cache, MODELS[name])))
  return found.every(Boolean)
}

const download = async (item, onChunk) => {
  const res = await fetch(item.url)
  if (!res.ok) throw new Error(`Could not download ${item.name} (${res.status})`)
  const out = new Uint8Array(item.bytes)
  const reader = res.body?.getReader()
  let offset = 0
  if (reader) {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      if (offset + value.byteLength > item.bytes) throw new Error(`Size mismatch for ${item.name}`)
      out.set(value, offset)
      offset += value.byteLength
      onChunk(value.byteLength)
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength !== item.bytes) throw new Error(`Size mismatch for ${item.name}`)
    out.set(buf)
    offset = buf.byteLength
    onChunk(offset)
  }
  if (offset !== item.bytes || !await verify(out.buffer, item.sha256)) throw new Error(`Integrity check failed for ${item.name}`)
  return out.buffer
}

export const loadModels = (names, options = {}) => {
  const {confirm = consentHook, onProgress} = typeof options === 'function' ? {onProgress: options} : options
  const run = async () => {
    const cache = await openCache()
    const loaded = {}
    const missing = []
    for (const name of names) {
      const item = MODELS[name]
      if (!item) throw new Error(`Unknown model ${name}`)
      const hit = await readCached(cache, item)
      if (hit) loaded[name] = hit
      else missing.push(item)
    }
    if (!missing.length) return loaded
    if (typeof navigator === 'object' && navigator.onLine === false) throw new Error('Offline: model download needs a connection')
    const total = missing.reduce((sum, item) => sum + item.bytes, 0)
    if (confirm && !approved) {
      if (!await confirm({bytes: total, models: missing})) throw new Error('Model download declined')
      approved = true
    }
    let done = 0
    const report = info => {onProgress?.(info); progressHook?.(info)}
    try {
      report({loaded: 0, total, share: 0})
      for (const item of missing) {
        const buf = await download(item, bytes => {
          done += bytes
          report({loaded: done, total, share: done / total})
        })
        if (cache) await cache.put(item.url, new Response(buf.slice(0), {headers: {'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.byteLength)}})).catch(() => {})
        else memory.set(item.name, buf.slice(0))
        loaded[item.name] = buf
      }
      return loaded
    } finally {report(null)}
  }
  const task = (inflight ?? Promise.resolve()).catch(() => {}).then(run)
  inflight = task
  return task
}

export const loadModel = async (name, options) => (await loadModels([name], options))[name]
