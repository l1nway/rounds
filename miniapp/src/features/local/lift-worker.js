import * as ort from 'onnxruntime-web/webgpu'
import {EMBEDDINGS, GRID, MAX_MASK, SIDE, clean, distinct, png, toChw} from './lift-mask.js'

// [DOC: local-lift-worker]
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  let enc = null, dec = null
  let encBuf = null, decBuf = null
  let useGpu = false
  const cache = new Map()
  const zeroMask = new ort.Tensor('float32', new Float32Array(GRID * GRID), [1, 1, GRID, GRID])
  const noMask = new ort.Tensor('float32', new Float32Array([0]), [1])

  const createSessions = async gpu => {
    const ep = gpu ? ['webgpu', 'wasm'] : ['wasm']
    enc = await ort.InferenceSession.create(encBuf, {executionProviders: ep})
    dec = await ort.InferenceSession.create(decBuf, {executionProviders: ep})
  }

  const runWithFallback = async fn => {
    try {
      return await fn()
    } catch (err) {
      if (useGpu) {
        console.warn('Lift WebGPU failed, falling back to WASM:', err?.message)
        useGpu = false
        cache.clear()
        await createSessions(false)
        return await fn()
      }
      throw err
    }
  }

  self.onmessage = async ({data}) => {
    const {id, type} = data
    try {
      if (type === 'init') {
        ort.env.wasm.numThreads = 1
        useGpu = Boolean(data.gpu)
        encBuf = data.encBuf
        decBuf = data.decBuf
        try {
          await createSessions(useGpu)
        } catch {
          useGpu = false
          await createSessions(false)
        }
        return self.postMessage({id, ok: true})
      }
      const result = await runWithFallback(async () => {
        const {key, rgba, points, box, width, height} = data
        if (!cache.has(key)) {
          const emb = await enc.run({pixel_values: new ort.Tensor('float32', toChw(rgba), [1, 3, SIDE, SIDE])})
          cache.set(key, emb)
          if (cache.size > EMBEDDINGS) cache.delete(cache.keys().next().value)
        }
        const emb = cache.get(key)
        cache.delete(key)
        cache.set(key, emb)
        const all = [...(box ? [[box[0], box[1], 2], [box[2], box[3], 3]] : []), ...(points ?? [])]
        const coords = new Float32Array(all.length * 2), labels = new BigInt64Array(all.length)
        all.forEach(([x, y, l], i) => {coords[i * 2] = x * SIDE; coords[i * 2 + 1] = y * SIDE; labels[i] = BigInt(l)})
        const out = await dec.run({
          ...emb,
          input_points: new ort.Tensor('float32', coords, [1, 1, all.length, 2]),
          input_labels: new ort.Tensor('int64', labels, [1, 1, all.length]),
          input_masks: zeroMask,
          has_mask_input: noMask
        })
        const scale = Math.min(0.5, MAX_MASK / Math.max(width, height))
        const mw = Math.max(16, Math.round(width * scale)), mh = Math.max(16, Math.round(height * scale))
        const slots = (points?.length ?? 0) === 1 && !box ? [1, 2, 3] : [0]
        const kept = distinct(slots.map(s => clean(out.pred_masks.data.subarray(s * GRID * GRID, (s + 1) * GRID * GRID), mw, mh)))
        const candidates = await Promise.all(kept.map(async m => ({mask: await png(m.mask, mw, mh), area: Math.round(m.sum / (mw * mh) * 1e4) / 1e4})))
        return {candidates, best: candidates.length >> 1}
      })
      self.postMessage({id, result})
    } catch (error) {
      self.postMessage({id, error: error?.message || 'Local segmentation failed'})
    }
  }
}
