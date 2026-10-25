import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import './index.css'
import App from './app.jsx'
import {setupTelegram} from './services/telegram.js'

if (!import.meta.env.VITE_API_URL) await import('./services/mock.js')
setupTelegram()

createRoot(document.getElementById('root')).render(<StrictMode><App/></StrictMode>)
