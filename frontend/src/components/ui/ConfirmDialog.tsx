import { createContext, useCallback, useContext, useRef, useState } from 'react'

// 破壊的操作の確認ダイアログ（詳細設計書 画面設計11.6節）。window.confirm は使わない方針。
export interface ConfirmOptions {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

const ConfirmContext = createContext<(opts: ConfirmOptions) => Promise<boolean>>(
  () => Promise.resolve(false),
)

export function useConfirm() {
  return useContext(ConfirmContext)
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback((opts: ConfirmOptions) => {
    setCurrent(opts)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
    })
  }, [])

  const close = (ok: boolean) => {
    setCurrent(null)
    resolver.current?.(ok)
    resolver.current = null
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {current && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,24,33,0.45)] p-6"
          onClick={() => close(false)}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            className="w-full max-w-md rounded-[14px] bg-surface p-6 shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
            onClick={(e) => e.stopPropagation()}
          >
            {current.title && <h2 className="text-[15.5px] font-bold text-ink">{current.title}</h2>}
            <p className={`whitespace-pre-wrap text-sm text-ink-muted ${current.title ? 'mt-2' : ''}`}>
              {current.message}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                autoFocus
                onClick={() => close(false)}
                className="rounded-lg border border-line-strong px-4 py-1.5 text-sm text-ink-muted hover:bg-surface-subtle"
              >
                {current.cancelLabel ?? 'キャンセル'}
              </button>
              <button
                onClick={() => close(true)}
                className={`rounded-lg px-5 py-1.5 text-sm font-medium text-white ${
                  current.danger ? 'bg-danger-text hover:opacity-90' : 'bg-accent-600 hover:bg-accent-700'
                }`}
              >
                {current.confirmLabel ?? 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}
