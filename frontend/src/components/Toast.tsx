import { createContext, useCallback, useContext, useRef, useState } from 'react'

// トースト通知（詳細設計書 画面設計11.3節・11.6節）。kindは success/error/info の3種。
// info は総論5.9節の権限外リダイレクト通知に使う（例:「このページを表示する権限がありません」）。
type ToastKind = 'success' | 'error' | 'info'

interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}

const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => {})

export function useToast() {
  return useContext(ToastContext)
}

// info（権限外リダイレクト通知）は画面モックアップ.toastと同じ配色。success/errorは同じ形のまま色だけ変える。
const KIND_CLASS: Record<ToastKind, string> = {
  success: 'bg-ok-text',
  error: 'bg-danger-text',
  info: 'bg-ink',
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const show = useCallback((message: string, kind: ToastKind = 'success') => {
    const id = nextId.current++
    setToasts((t) => [...t, { id, message, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000)
  }, [])

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed left-1/2 top-[18px] z-50 -translate-x-1/2 space-y-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-[10px] px-4 py-[11px] text-[12.5px] font-semibold text-white shadow-[0_10px_26px_rgba(0,0,0,0.28)] ${KIND_CLASS[t.kind]}`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
