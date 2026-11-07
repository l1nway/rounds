import {createRoot} from 'react-dom/client'
import './index.css'
import App from './app.jsx'
import {reloadOnStaleChunk} from './services/stale.js'
import {setupTelegram} from './services/telegram.js'
import {startTelemetry} from './services/telemetry.js'

// [DOC: telemetry]
const sampleDevice = () => import('./features/local/device.js').then(device => device.sampleDevice())

reloadOnStaleChunk()
setupTelegram()
startTelemetry(sampleDevice)

createRoot(document.getElementById('root')).render(<App/>)
