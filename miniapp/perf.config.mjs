import {fileURLToPath} from 'node:url'

// [DOC: perf-harness]
const config = {
  serve: port => [fileURLToPath(new URL('node_modules/vite/bin/vite.js', import.meta.url)), 'preview', '--port', port, '--strictPort'],
  path: '/?job=ready',
  interactions: ['.options-row input', '[aria-label="Next frame"]', '[aria-label="Play"]']
}

export default config
