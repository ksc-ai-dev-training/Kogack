import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'
import { ToastProvider } from './components/Toast.tsx'
import { ConfirmProvider } from './components/ui/ConfirmDialog.tsx'
import { UnsavedChangesProvider } from './lib/unsavedChanges.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <ConfirmProvider>
          {/* 未保存の変更ガード（2026-09-11）。GuardedLink/GuardedNavLink・
              useReportDirtyの両方から参照するため、Layout・各ページより上位に置く */}
          <UnsavedChangesProvider>
            <App />
          </UnsavedChangesProvider>
        </ConfirmProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
)
