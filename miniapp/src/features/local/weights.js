const CACHE = 'rounds-models-v1'
const REV = 'b3234dc2bf3cfd9475755d20a5dd11308c56e6ae'
const BASE = `https://huggingface.co/Geo-IA/evo-sam2.1-onnx/resolve/${REV}/sam2.1_hiera_tiny`
const V_REV = '66673b5db39371b7dd7847f4d3bc0d4f4179b79e'
const V_BASE = `https://huggingface.co/diffusionstudio/sam2.1-tiny-video-onnx-fp16/resolve/${V_REV}/onnx`
const E_BASE = 'https://huggingface.co/chongzhou/EdgeSAM/resolve/e0564124628944e1622973d4e0f68158b46f035a'
const SAM = 'SAM 2.1 Tiny (Meta Segment Anything 2.1)'
const EDGE_SAM = 'EdgeSAM (S-Lab, Nanyang Technological University, non-commercial licence)'

// [DOC: edge-sam-cast]
const INT16_CAST = [0x0a, 0x02, 0x74, 0x6f, 0x18, 0x05]
const castToInt64 = bytes => {
  for (let i = bytes.indexOf(INT16_CAST[0]); i >= 0; i = bytes.indexOf(INT16_CAST[0], i + 1)) {
    if (INT16_CAST.every((b, k) => bytes[i + k] === b)) bytes[i + 5] = 7
  }
}

// [DOC: local-models]
export const MODELS = {
  'sam2.1-tiny-encoder': {
    name: 'sam2.1-tiny-encoder', credit: SAM,
    url: `${BASE}/vision_encoder_fp16.onnx`,
    bytes: 67_313_499,
    sha256: 'f4ca896cf99816ad0cb7062e9ebef44a211e6f0d0a0656a7eb13349204cb6caa'
  },
  'sam2.1-tiny-decoder': {
    name: 'sam2.1-tiny-decoder', credit: SAM,
    url: `${BASE}/prompt_encoder_mask_decoder_fp16.onnx`,
    bytes: 8_755_200,
    sha256: 'f362ed5bbcfbece283ce970a2162486da9f018645a382b927755677b9d267e6d'
  },
  'edge-sam-encoder': {
    name: 'edge-sam-encoder', credit: EDGE_SAM,
    url: `${E_BASE}/edge_sam_3x_encoder.onnx`,
    bytes: 22_098_300,
    sha256: '719a498cf5b3fe9be9f01ee513e13d3915f9028aa4f23dfd30eaaa0a17143159'
  },
  'edge-sam-decoder': {
    name: 'edge-sam-decoder', credit: EDGE_SAM, patch: castToInt64,
    url: `${E_BASE}/edge_sam_3x_decoder.onnx`,
    bytes: 15_937_006,
    sha256: '83a2174d54571596913dcb7455d021e713623c3dca30a31c8c41ab98c9fb0863'
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

const approved = new Set()
let inflight = null
const memory = new Map()

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

const download = async (item, onChunk) => {
  const res = await fetch(item.url)
  if (!res.ok) throw new Error(`Could not download ${item.name} (${res.status})`)
  const out = new Uint8Array(item.bytes)
  const reader = res.body.getReader()
  let offset = 0
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    if (offset + part.value.byteLength > item.bytes) throw new Error(`Size mismatch for ${item.name}`)
    out.set(part.value, offset)
    offset += part.value.byteLength
    onChunk(part.value.byteLength)
  }
  if (offset !== item.bytes || !await verify(out.buffer, item.sha256)) throw new Error(`Integrity check failed for ${item.name}`)
  return out.buffer
}

export const loadModels = (names, {confirm, onProgress, onReady, onRead} = {}) => {
  const run = async () => {
    const cache = await openCache()
    // [DOC: model-ready]
    const stored = await Promise.all(names.map(name => memory.has(name) || cache?.match(MODELS[name].url).then(Boolean, () => false)))
    if (stored.every(Boolean)) onReady?.()
    const loaded = {}
    const missing = []
    const size = names.reduce((sum, name) => sum + MODELS[name].bytes, 0)
    let read = 0
    for (const name of names) {
      const hit = await readCached(cache, MODELS[name])
      if (hit) {loaded[name] = hit; onRead?.((read += hit.byteLength) / size)}
      else missing.push(MODELS[name])
    }
    const patched = () => {names.forEach(name => MODELS[name].patch?.(new Uint8Array(loaded[name]))); return loaded}
    if (!missing.length) return patched()
    if (!navigator.onLine) throw new Error('Offline: model download needs a connection')
    const total = missing.reduce((sum, item) => sum + item.bytes, 0)
    if (confirm && missing.some(item => !approved.has(item.name))) {
      if (!await confirm({bytes: total, models: missing})) throw new Error('Model download declined')
      missing.forEach(item => approved.add(item.name))
    }
    let done = 0
    try {
      onProgress?.({loaded: 0, total, share: 0})
      for (const item of missing) {
        const buf = await download(item, bytes => {
          done += bytes
          onProgress?.({loaded: done, total, share: done / total})
        })
        // [DOC: model-copies]
        if (cache) await cache.put(item.url, new Response(buf, {headers: {'Content-Type': 'application/octet-stream'}})).catch(() => {})
        else memory.set(item.name, buf.slice(0))
        loaded[item.name] = buf
      }
      return patched()
    } finally {onProgress?.(null)}
  }
  const task = (inflight ?? Promise.resolve()).catch(() => {}).then(run)
  inflight = task
  return task
}
