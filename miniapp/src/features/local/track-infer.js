import * as ort from 'onnxruntime-web/webgpu'
import {histogram, measure} from './track-measure.js'
import {TPOS} from './tpos.js'

const SIDE = 512, PLANE = 1024, DIM = 256, MEM_DIM = 64, NUM_MEM = 7, PTRS = 16, RECENT = 15
const TOTAL_MEM = NUM_MEM * PLANE + PTRS * 4
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225]
const NO_POINT = {input_points: new ort.Tensor('float32', new Float32Array([0, 0]), [1, 1, 1, 2]), input_labels: new ort.Tensor('int32', new Int32Array([-1]), [1, 1, 1])}

// [DOC: track-buffers]
const chw = new Float32Array(3 * SIDE * SIDE)
const feats = new Float32Array(PLANE * DIM)
const mem = new Float32Array(TOTAL_MEM * MEM_DIM), memPos = new Float32Array(TOTAL_MEM * MEM_DIM)
let pos = null
let state = null

const toChw = rgba => {
  const bytes = new Uint8Array(rgba), plane = SIDE * SIDE
  const [s0, s1, s2] = STD.map(s => 1 / (255 * s)), [o0, o1, o2] = MEAN.map((m, i) => m / STD[i])
  for (let i = 0, p = 0; i < plane; i++, p += 4) {
    chw[i] = bytes[p] * s0 - o0; chw[plane + i] = bytes[p + 1] * s1 - o1; chw[2 * plane + i] = bytes[p + 2] * s2 - o2
  }
  return new ort.Tensor('float32', chw, [1, 3, SIDE, SIDE])
}

const tokens = (src, out) => {
  for (let c = 0; c < DIM; c++) for (let i = 0; i < PLANE; i++) out[i * DIM + c] = src[c * PLANE + i]
  return new ort.Tensor('float32', out, [PLANE, 1, DIM])
}

const attend = async (memAttn, ptr, image) => {
  const c = state.frameIdx, bank = [{...state.cond, tpos: NUM_MEM - 1}]
  for (let off = NUM_MEM - 1; off >= 1; off--) {
    const it = state.recent.get(c - off)
    if (it) bank.push({...it, tpos: off - 1})
  }
  while (bank.length < NUM_MEM) bank.push(bank[bank.length - 1])
  bank.forEach((entry, b) => {
    const base = b * PLANE * MEM_DIM, tp = TPOS[entry.tpos]
    mem.set(entry.tokens, base)
    for (let i = 0; i < PLANE; i++) for (let d = 0, o = i * MEM_DIM; d < MEM_DIM; d++) memPos[base + o + d] = entry.pos[o + d] + tp[d]
  })
  const ptrs = [{diff: c - state.cond.frameIdx, pointer: state.cond.pointer}]
  for (let off = 1; off < PTRS; off++) {
    const it = state.recent.get(c - off)
    if (it) ptrs.push({diff: off, pointer: it.pointer})
  }
  while (ptrs.length < PTRS) ptrs.push(ptrs[ptrs.length - 1])
  const scale = Math.max(1, Math.min(state.total, PTRS) - 1)
  const ptrOut = await ptr.run({normalized_diffs: new ort.Tensor('float32', Float32Array.from(ptrs, p => p.diff / scale), [PTRS])})
  const ptrData = ptrOut.pointer_pos.data, base = NUM_MEM * PLANE * MEM_DIM
  ptrs.forEach(({pointer}, i) => {
    for (let r = 0; r < 4; r++) {
      const dst = base + (i * 4 + r) * MEM_DIM
      mem.set(pointer.subarray(r * MEM_DIM, (r + 1) * MEM_DIM), dst)
      memPos.set(ptrData.subarray(i * MEM_DIM, (i + 1) * MEM_DIM), dst)
    }
  })
  pos ??= tokens(image.vision_pos_embed.data, new Float32Array(PLANE * DIM))
  const out = await memAttn.run({
    current_vision_features: tokens(image.feats2.data, feats),
    current_vision_position_embeddings: pos,
    memory: new ort.Tensor('float32', mem, [TOTAL_MEM, 1, MEM_DIM]),
    memory_pos: new ort.Tensor('float32', memPos, [TOTAL_MEM, 1, MEM_DIM])
  })
  return out.conditioned_feats
}

const decode = async ([, dec, memEnc], image, cond, prompt, first) => {
  const out = await dec.run({feats0: image.feats0, feats1: image.feats1, feats2_cond: cond, ...prompt})
  const score = out.object_score_logits.data[0]
  const memory = await memEnc.run({
    feats2: image.feats2, high_res_mask: out.high_res_mask,
    object_score_logits: new ort.Tensor('float32', new Float32Array([score]), [1, 1]),
    binarize: new ort.Tensor('float32', new Float32Array([first ? 1 : 0]), [])
  })
  const entry = {tokens: new Float32Array(memory.memory_tokens.data), pos: new Float32Array(memory.memory_pos.data), pointer: new Float32Array(out.object_pointer.data)}
  return {entry, mask: out.low_res_mask.data, score}
}

const result = ({mask, score}, rgba) => ({...measure(mask, score, SIDE, SIDE), hist: histogram(new Uint8Array(rgba), SIDE, SIDE)})

// [DOC: local-track]
export const seed = async (sessions, {rgba, prompt, total}) => {
  const image = await sessions[0].run({pixel_values: toChw(rgba)})
  const all = [...(prompt.box ? [[prompt.box[0], prompt.box[1], 2], [prompt.box[2], prompt.box[3], 3]] : []), ...(prompt.points ?? [])]
  const coords = new Float32Array(all.length * 2), labels = new Int32Array(all.length)
  all.forEach(([x, y, l], i) => {coords[i * 2] = x * SIDE; coords[i * 2 + 1] = y * SIDE; labels[i] = l})
  const points = {input_points: new ort.Tensor('float32', coords, [1, 1, all.length, 2]), input_labels: new ort.Tensor('int32', labels, [1, 1, all.length])}
  const found = await decode(sessions, image, image.feats2_no_mem, points, true)
  state = {frameIdx: 1, total, cond: {...found.entry, frameIdx: 0}, recent: new Map()}
  return result(found, rgba)
}

export const step = async (sessions, {rgba}) => {
  if (!state) throw new Error('Tracking was not seeded')
  const image = await sessions[0].run({pixel_values: toChw(rgba)})
  const found = await decode(sessions, image, await attend(sessions[3], sessions[4], image), NO_POINT, false)
  state.recent.set(state.frameIdx, found.entry)
  state.recent.delete(state.frameIdx - RECENT)
  state.frameIdx++
  return result(found, rgba)
}

export const reset = () => {state = null}
