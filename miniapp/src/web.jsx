import {createRoot} from 'react-dom/client'
import './index.css'
import App from './app.jsx'
import {enter} from './services/telegram.js'

enter()

createRoot(document.getElementById('root')).render(<App/>)
