import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './styles/tokens.css'
import './styles/reset.css'
import './styles/typography.css'
import './styles/layout.css'
import './styles/buttons.css'
import './styles/forms.css'
import './styles/utils.css'
import App from './App'
import { initializeAnalytics } from './analytics'
import { ErrorBoundary } from './components/ErrorBoundary'

initializeAnalytics()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
