import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// Bundled locally (Phase 13A) — Electron must never fetch fonts at runtime.
// 'standard' is Inter Variable's weight-axis-only build (no italic), which
// is all --font-sans needs. JetBrains Mono ships as static weights; 400/500
// cover --font-mono's current uses (paths, SKUs, config values).
import '@fontsource-variable/inter/standard.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import './global.css'

// One-time OS-preference read for the reduced-motion/reduced-transparency
// data attributes global.css's collapse rules key off of (Phase 13A
// scaffolding — see global.css's comment). 13H's Settings > Appearance
// toggles will later set these attributes explicitly, overriding the OS
// signal; until then this is the only thing that sets them.
function applyReducedPreferenceAttributes() {
  const root = document.documentElement
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    root.setAttribute('data-reduced-motion', 'true')
  }
  if (window.matchMedia('(prefers-reduced-transparency: reduce)').matches) {
    root.setAttribute('data-reduced-transparency', 'true')
  }
}
applyReducedPreferenceAttributes()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
