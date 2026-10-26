// usage: npm run mock (needs ffmpeg and ffprobe on PATH)
import {execFileSync} from 'node:child_process'
import {mkdirSync, writeFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

const OUT = fileURLToPath(new URL('../public/mock/', import.meta.url))
const DURATION = 32
const TILES = 24
const TILE_HEIGHT = 96
const BALL = 'format=rgba,geq=r=255:g=59:b=48:a=\'if(lt(hypot(X-60,Y-60),56),255,0)\''
const PATH = 'x=\'420+330*sin(t*0.6)\':y=\'210+160*sin(t*1.1)\''

const TAGS = {
  creation_time: '2026-10-25T22:57:45.000000Z',
  'com.apple.quicktime.creationdate': '2026-10-25T23:57:45+0100',
  'com.apple.quicktime.location.ISO6709': '+52.3207+021.0548+092.015/',
  'com.apple.quicktime.make': 'Apple',
  'com.apple.quicktime.model': 'iPhone SE (2nd generation)',
  'com.apple.quicktime.camera.lens_model': 'iPhone SE (2nd generation) back camera 3.99mm f/1.8'
}

const run = (tool, args) => execFileSync(tool, args, {cwd: OUT, encoding: 'utf8'})

mkdirSync(OUT, {recursive: true})
run('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', `testsrc2=size=960x540:rate=30:duration=${DURATION}`,
  '-f', 'lavfi', '-i', `color=c=black:size=120x120:rate=30:duration=${DURATION}`,
  '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${DURATION}`,
  '-filter_complex', `[1]${BALL}[ball];[0][ball]overlay=${PATH}:shortest=1[v]`,
  '-map', '[v]', '-map', '2:a',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-g', '15', '-keyint_min', '15', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', 'proxy.mp4'
])
run('ffmpeg', ['-v', 'error', '-y', '-i', 'proxy.mp4', '-vf', `fps=${TILES}/${DURATION},scale=-2:${TILE_HEIGHT},tile=${TILES}x1`, '-frames:v', '1', '-q:v', '5', 'filmstrip.jpg'])

const duration = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', 'proxy.mp4']).trim())
const [width] = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', 'filmstrip.jpg']).trim().split(',')
const job = {
  meta: {duration, width: 1920, height: 1080, fps: 30, gaps: 0, dupes: 0, interpolable: true, has_audio: true, tags: TAGS},
  filmstrip: {tiles: TILES, tile_width: Number(width) / TILES, tile_height: TILE_HEIGHT}
}
writeFileSync(`${OUT}job.json`, JSON.stringify(job, null, 2))
console.log(`mock media in ${OUT}`, job)
