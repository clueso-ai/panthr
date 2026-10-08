import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/ui.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
