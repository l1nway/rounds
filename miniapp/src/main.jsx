import {createRoot} from 'react-dom/client'
import './index.css'
import App from './app.jsx'
import {setupTelegram} from './services/telegram.js'

setupTelegram()

createRoot(document.getElementById('root')).render(<App/>)
