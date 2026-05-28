import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { installExternalLinkInterceptor } from './lib/external-link'

// Mobile WebView: route external links through the OS browser via the Tauri
// shell plugin. No-op in a normal desktop/mobile browser.
installExternalLinkInterceptor()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
