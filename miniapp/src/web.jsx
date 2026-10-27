import {createRoot} from 'react-dom/client'
import css from './features/auth/login.css?inline'
import upload from './features/upload/upload.css?inline'
import Login from './features/auth/login.jsx'
import {enter} from './services/telegram.js'

// [DOC: inline-css]
if (import.meta.env.DEV) await import('./index.css')
document.head.append(Object.assign(document.createElement('style'), {textContent: css + upload}))
enter()

createRoot(document.getElementById('root')).render(<Login/>)
