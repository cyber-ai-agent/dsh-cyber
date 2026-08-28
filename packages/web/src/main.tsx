import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App.js'
import { ApplicationLockGate } from './components/ApplicationLockGate.js'
import './styles.css'
import './styles-world-settings.css'
import './features/world/world-runtime.css'
import './features/artifacts/artifacts.css'

// Keep translation catalogs outside the main application chunk while still
// registering them before the first React render, so locale changes never flash
// untranslated fallback copy.
await Promise.all([
  import('./i18n/messages.js'),
  import('./i18n/shell-messages.js'),
  import('./i18n/workbench-messages.js'),
  import('./i18n/appearance-messages.js'),
  import('./i18n/workshop-messages.js'),
  import('./i18n/settings-model-messages.js'),
  import('./i18n/group-turn-messages.js'),
  import('./i18n/world-settings-messages.js'),
  import('./i18n/world-scene-messages.js'),
  import('./i18n/knowledge-messages.js'),
])

const root = document.getElementById('root')
if (root === null) throw new Error('Missing #root')

createRoot(root).render(
  <StrictMode>
    <ApplicationLockGate><App /></ApplicationLockGate>
  </StrictMode>,
)
