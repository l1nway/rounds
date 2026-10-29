import {open} from './src/features/local/render.js'
import {Conversion, Output, BufferTarget, Mp4OutputFormat, Quality} from 'mediabunny'
import fs from 'fs'

async function testEncode() {
  const fileBuf = fs.readFileSync('C:/Users/l1nway/Downloads/IMG_5452.mp4')
  const blob = new Blob([fileBuf], {type: 'video/mp4'})
  const input = open(blob)

  const output = new Output({
    format: new Mp4OutputFormat({fastStart: 'in-memory'}),
    target: new BufferTarget()
  })

  // Test static crop: {left: 0, top: 280, width: 720, height: 720}
  const crop = {left: 0, top: 280, width: 720, height: 720}

  const conversion = await Conversion.init({
    input, output, trim: {start: 0, end: 1}, showWarnings: true,
    video: {
      crop,
      width: 640, height: 640, fit: 'fill', codec: 'av1', forceTranscode: true,
      quality: new Quality({bitrate: 2000000})
    },
    audio: {discard: true}
  })

  console.log('Conversion valid:', conversion.isValid)
  await conversion.execute()
  fs.writeFileSync('C:/Users/l1nway/.gemini/antigravity/brain/19042623-87cd-4164-a84d-31146a7c0cb7/scratch/test_crop.mp4', Buffer.from(output.target.buffer))
  console.log('Saved test_crop.mp4!')
}

testEncode().catch(console.error)
