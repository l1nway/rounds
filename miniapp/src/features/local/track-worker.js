import * as ort from 'onnxruntime-web/webgpu'
import {histogram, measure} from './track-measure.js'
import {TPOS} from './tpos.js'

const SIDE = 512, PLANE = 1024, DIM = 256, MEM_DIM = 64, NUM_MEM = 7, PTRS = 16
const TOTAL_MEM = NUM_MEM * PLANE + PTRS * 4
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225]

const toChw = rgba => {
  const bytes = new Uint8Array(rgba), plane = SIDE * SIDE, out = new Float32Array(3 * plane)
  const [s0, s1, s2] = STD.map(s => 1 / (255 * s)), [o0, o1, o2] = MEAN.map((m, i) => m / STD[i])
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    out[i] = bytes[p] * s0 - o0; out[plane + i] = bytes[p + 1] * s1 - o1; out[2 * plane + i] = bytes[p + 2] * s2 - o2
  }
  return out
}

const transposeFeats = src => {
  const out = new Float32Array(PLANE * DIM)
  for (let c = 0; c < DIM; c++) for (let i = 0; i < PLANE; i++) out[i * DIM + c] = src[c * PLANE + i]
  return out
}

// [DOC: local-track-worker]
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  let enc = null, dec = null, memEnc = null, memAttn = null, ptr = null, tpos = null, state = null
  let bufs = null, useGpu = false

  const createSessions = async gpu => {
    const ep = gpu ? ['webgpu', 'wasm'] : ['wasm']
    const sessions = []
    for (const buf of bufs) sessions.push(await ort.InferenceSession.create(buf, {executionProviders: ep}))
    ;[enc, dec, memEnc, memAttn, ptr] = sessions
  }

  const runWithFallback = async fn => {
    try {
      return await fn()
    } catch (err) {
      if (useGpu) {
        console.warn('Track WebGPU failed, falling back to WASM:', err?.message)
        useGpu = false
        await createSessions(false)
        return await fn()
      }
      throw err
    }
  }

  const attend = async feats => {
    const c = state.frameIdx, bank = [{tokens: state.cond.tokens, pos: state.cond.pos, tposIdx: NUM_MEM - 1}]
    for (let off = NUM_MEM - 1; off >= 1; off--) {
      const it = state.recent.get(c - off); if (it) bank.push({tokens: it.tokens, pos: it.pos, tposIdx: off - 1})
    }
    while (bank.length < NUM_MEM) bank.push(bank[bank.length - 1])
    const mem = new Float32Array(TOTAL_MEM * MEM_DIM), memPos = new Float32Array(TOTAL_MEM * MEM_DIM)
    for (let b = 0; b < NUM_MEM; b++) {
      const entry = bank[b], base = b * PLANE * MEM_DIM, tp = tpos[entry.tposIdx]
      mem.set(entry.tokens, base)
      for (let i = 0; i < PLANE; i++) {
        const pOff = base + i * MEM_DIM, sOff = i * MEM_DIM
        for (let d = 0; d < MEM_DIM; d++) memPos[pOff + d] = entry.pos[sOff + d] + tp[d]
      }
    }
    const ptrs = [{diff: c - state.cond.frameIdx, pointer: state.cond.pointer}]
    for (let off = 1; off < PTRS; off++) {
      const it = state.recent.get(c - off); if (it) ptrs.push({diff: off, pointer: it.pointer})
    }
    while (ptrs.length < PTRS) ptrs.push(ptrs[ptrs.length - 1])
    const scale = Math.max(1, Math.min(state.total, PTRS) - 1)
    const diffs = Float32Array.from(ptrs, p => p.diff / scale)
    const ptrOut = await ptr.run({normalized_diffs: new ort.Tensor('float32', diffs, [PTRS])})
    const ptrData = ptrOut.pointer_pos.data, base = NUM_MEM * PLANE * MEM_DIM
    for (let i = 0; i < PTRS; i++) {
      const p = ptrs[i].pointer
      for (let r = 0; r < 4; r++) {
        const dst = base + (i * 4 + r) * MEM_DIM
        for (let d = 0; d < MEM_DIM; d++) {mem[dst + d] = p[r * MEM_DIM + d]; memPos[dst + d] = ptrData[i * MEM_DIM + d]}
      }
    }
    const curFeats = transposeFeats(feats.feats2.data), curPos = transposeFeats(feats.vision_pos_embed.data)
    const out = await memAttn.run({
      current_vision_features: new ort.Tensor('float32', curFeats, [PLANE, 1, DIM]),
      current_vision_position_embeddings: new ort.Tensor('float32', curPos, [PLANE, 1, DIM]),
      memory: new ort.Tensor('float32', mem, [TOTAL_MEM, 1, MEM_DIM]),
      memory_pos: new ort.Tensor('float32', memPos, [TOTAL_MEM, 1, MEM_DIM])
    })
    return out.conditioned_feats
  }

  self.onmessage = async ({data}) => {
    const {id, type} = data
    try {
      if (type === 'init') {
        ort.env.wasm.numThreads = 1
        useGpu = Boolean(data.gpu)
        bufs = [data.encBuf, data.decBuf, data.memEncBuf, data.memAttnBuf, data.ptrBuf]
        try {
          await createSessions(useGpu)
        } catch {
          useGpu = false
          await createSessions(false)
        }
        tpos = TPOS
        return self.postMessage({id, ok: true})
      }
      if (type === 'seed') {
        const result = await runWithFallback(async () => {
          const {rgba, prompt, total, width, height} = data
          const feats = await enc.run({pixel_values: new ort.Tensor('float32', toChw(rgba), [1, 3, SIDE, SIDE])})
          const all = [...(prompt.box ? [[prompt.box[0], prompt.box[1], 2], [prompt.box[2], prompt.box[3], 3]] : []), ...(prompt.points ?? [])]
          const coords = new Float32Array(all.length * 2), labels = new Int32Array(all.length)
          all.forEach(([x, y, l], i) => {coords[i * 2] = x * SIDE; coords[i * 2 + 1] = y * SIDE; labels[i] = l})
          const decOut = await dec.run({feats0: feats.feats0, feats1: feats.feats1, feats2_cond: feats.feats2_no_mem, input_points: new ort.Tensor('float32', coords, [1, 1, all.length, 2]), input_labels: new ort.Tensor('int32', labels, [1, 1, all.length])})
          const score = decOut.object_score_logits.data[0], pointer = new Float32Array(decOut.object_pointer.data)
          const memOut = await memEnc.run({feats2: feats.feats2, high_res_mask: decOut.high_res_mask, object_score_logits: new ort.Tensor('float32', new Float32Array([score]), [1, 1]), binarize: new ort.Tensor('float32', new Float32Array([1]), [])})
          const cond = {tokens: new Float32Array(memOut.memory_tokens.data), pos: new Float32Array(memOut.memory_pos.data), pointer, frameIdx: 0}
          state = {frameIdx: 1, total, cond, recent: new Map()}
          return {...measure(decOut.low_res_mask.data, score, width, height), hist: histogram(new Uint8Array(rgba), SIDE, SIDE)}
        })
        return self.postMessage({id, result})
      }
      if (type === 'step') {
        const result = await runWithFallback(async () => {
          const {rgba, width, height} = data
          const feats = await enc.run({pixel_values: new ort.Tensor('float32', toChw(rgba), [1, 3, SIDE, SIDE])})
          const condFeats = await attend(feats)
          const decOut = await dec.run({feats0: feats.feats0, feats1: feats.feats1, feats2_cond: condFeats, input_points: new ort.Tensor('float32', new Float32Array([0, 0]), [1, 1, 1, 2]), input_labels: new ort.Tensor('int32', new Int32Array([-1]), [1, 1, 1])})
          const score = decOut.object_score_logits.data[0], pointer = new Float32Array(decOut.object_pointer.data)
          const memOut = await memEnc.run({feats2: feats.feats2, high_res_mask: decOut.high_res_mask, object_score_logits: new ort.Tensor('float32', new Float32Array([score]), [1, 1]), binarize: new ort.Tensor('float32', new Float32Array([0]), [])})
          state.recent.set(state.frameIdx, {tokens: new Float32Array(memOut.memory_tokens.data), pos: new Float32Array(memOut.memory_pos.data), pointer})
          for (const old of state.recent.keys()) if (old < state.frameIdx - 15) state.recent.delete(old)
          state.frameIdx++
          return {...measure(decOut.low_res_mask.data, score, width, height), hist: histogram(new Uint8Array(rgba), SIDE, SIDE)}
        })
        return self.postMessage({id, result})
      }
      if (type === 'release') {
        state = null
        return self.postMessage({id, ok: true})
      }
    } catch (err) {
      self.postMessage({id, error: err?.message || 'Track worker error'})
    }
  }
}
