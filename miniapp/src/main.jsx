import {createRoot} from 'react-dom/client'
import './index.css'
import App from './app.jsx'
import {reloadOnStaleChunk} from './services/stale.js'
import {setupTelegram} from './services/telegram.js'

reloadOnStaleChunk()
setupTelegram()

createRoot(document.getElementById('root')).render(<App/>)
