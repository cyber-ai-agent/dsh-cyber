import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App.js'
import './styles.css'
import './styles-world-settings.css'
import './features/world/world-runtime.css'

const root = document.getElementById('root')
if (root === null) throw new Error('Missing #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
