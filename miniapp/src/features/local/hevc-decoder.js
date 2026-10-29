import initialize from '@yume-chan/libde265/libde265.mjs'
import {CustomVideoDecoder, VideoSample, registerDecoder} from 'mediabunny'

const wasmUrl = new URL('@yume-chan/libde265/libde265.wasm', import.meta.url).href
let modulePromise = null
const getModule = () => modulePromise ??= initialize({locateFile: () => wasmUrl})

const nativeChecks = new Map()
let baselineChecked = false
let baselineNativeHevc = false

const configKey = config => config ? `${config.codec ?? ''}:${config.codedWidth ?? 0}x${config.codedHeight ?? 0}` : ''

const checkBaseline = async () => {
  if (baselineChecked) return baselineNativeHevc
  baselineChecked = true
  if (typeof VideoDecoder === 'undefined' || !VideoDecoder.isConfigSupported) return (baselineNativeHevc = false)
  try {
    const res = await VideoDecoder.isConfigSupported({codec: 'hev1.1.6.L93.B0', codedWidth: 640, codedHeight: 640})
    return (baselineNativeHevc = res?.supported === true)
  } catch {
    return (baselineNativeHevc = false)
  }
}
if (typeof VideoDecoder !== 'undefined') checkBaseline()

// [DOC: local-hevc-check]
export const checkNativeHevc = async (codec, config) => {
  if (codec !== 'hevc') return false
  if (typeof VideoDecoder === 'undefined' || !VideoDecoder.isConfigSupported) return false
  const key = configKey(config)
  if (nativeChecks.has(key)) return nativeChecks.get(key)
  try {
    const res = await VideoDecoder.isConfigSupported(config)
    const ok = res?.supported === true
    nativeChecks.set(key, ok)
    return ok
  } catch {
    nativeChecks.set(key, false)
    return false
  }
}

export const ensureHevc = async track => {
  if (!track) return
  const [codec, config] = await Promise.all([track.getCodec().catch(() => null), track.getDecoderConfig().catch(() => null)])
  if (codec === 'hevc' && config) await checkNativeHevc(codec, config)
}

// [DOC: local-hevc-decoder]
export class HevcWasmDecoder extends CustomVideoDecoder {
  static supports(codec, config) {
    if (codec !== 'hevc') return false
    if (typeof VideoDecoder === 'undefined') return true
    if (config) {
      const key = configKey(config)
      if (nativeChecks.get(key) === true) return false
      if (nativeChecks.get(key) === false) return true
    }
    if (baselineNativeHevc) return false
    return true
  }

  async init() {
    const Module = await getModule()
    this.Module = Module
    this.decoder = new Module.Decoder()
    if (this.config.description) this.initHvcC(new Uint8Array(this.config.description))
  }

  initHvcC(desc) {
    const view = new DataView(desc.buffer, desc.byteOffset, desc.byteLength)
    const numOfArrays = view.getUint8(22)
    let offset = 23
    for (let i = 0; i < numOfArrays; i++) {
      offset++
      const numNalus = view.getUint16(offset, false)
      offset += 2
      for (let j = 0; j < numNalus; j++) {
        const len = view.getUint16(offset, false)
        offset += 2
        this.decoder.pushNal(desc.subarray(offset, offset + len), 0n)
        offset += len
      }
    }
  }

  async decode(packet) {
    const data = packet.data
    const pts = BigInt(Math.max(0, Math.round(packet.timestamp * 1e6)))
    if (this.config.description) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
      const desc = new Uint8Array(this.config.description)
      const lengthSize = (desc[21] & 3) + 1
      let off = 0
      while (off + lengthSize <= data.byteLength) {
        let len = 0
        for (let i = 0; i < lengthSize; i++) len = (len << 8) | view.getUint8(off + i)
        off += lengthSize
        if (len > 0 && off + len <= data.byteLength) {
          this.decoder.pushNal(data.subarray(off, off + len), pts)
          off += len
        }
      }
    } else {
      this.decoder.pushData(data, pts)
    }
    this.decoder.pushEndOfFrame()
    this.drain()
  }

  drain() {
    let more = true
    while (more) {
      const res = this.decoder.decode()
      more = res.more
      const img = this.decoder.getNextPicture()
      if (!img) continue
      this.emit(img)
    }
  }

  emit(img) {
    const y = img.getImagePlane(0), u = img.getImagePlane(1), v = img.getImagePlane(2)
    const w = y.width, h = y.height
    const yLen = y.stride * h, uLen = u.stride * (h >> 1), vLen = v.stride * (h >> 1)
    const buf = new Uint8Array(yLen + uLen + vLen)
    buf.set(y.bytes.subarray(0, yLen), 0)
    buf.set(u.bytes.subarray(0, uLen), yLen)
    buf.set(v.bytes.subarray(0, vLen), yLen + uLen)
    const ptsSec = Number(img.pts) / 1e6
    const layout = [
      {offset: 0, stride: y.stride},
      {offset: yLen, stride: u.stride},
      {offset: yLen + uLen, stride: v.stride}
    ]
    img.delete()
    let sample = null
    if (typeof VideoFrame !== 'undefined') {
      try {
        const vf = new VideoFrame(buf, {format: 'I420', codedWidth: w, codedHeight: h, timestamp: Math.round(ptsSec * 1e6), layout})
        sample = new VideoSample(vf)
      } catch {
        sample = new VideoSample(buf, {format: 'I420', codedWidth: w, codedHeight: h, timestamp: ptsSec, layout})
      }
    } else {
      sample = new VideoSample(buf, {format: 'I420', codedWidth: w, codedHeight: h, timestamp: ptsSec, layout})
    }
    this.onSample(sample)
  }

  async flush() {
    if (!this.decoder) return
    this.decoder.flushData()
    this.drain()
  }

  async close() {
    if (this.decoder) {
      this.decoder.delete()
      this.decoder = null
    }
  }
}

registerDecoder(HevcWasmDecoder)
