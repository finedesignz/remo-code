import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { installExternalLinkInterceptor } from './lib/external-link'
import { installGlobalErrorHandlers } from './lib/error-reporter'

// B3 observability: capture window.onerror + unhandledrejection before render
// so any throw during boot is shipped to the hub's Sentry intake.
installGlobalErrorHandlers()

// Mobile WebView: route external links through the OS browser via the Tauri
// shell plugin. No-op in a normal desktop/mobile browser.
installExternalLinkInterceptor()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
