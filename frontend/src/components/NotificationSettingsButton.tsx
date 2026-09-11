import { useEffect, useRef, useState } from 'react'
import type { NotifMode, NotifPermission } from '../hooks/useDesktopNotifications'

// サイドバーヘッダーのデスクトップ通知ボタン。許可の要求と「通知する対象（すべて／メンション・
// DMのみ）」の切替をまとめた小さなポップオーバー。ヘッダーは overflow クリップされる
// スクロール領域の外（最上部の flex-none）なので、ポータルは使わず単純な absolute 配置で足りる。
export default function NotificationSettingsButton({
  permission,
  requestPermission,
  mode,
  setMode,
}: {
  permission: NotifPermission
  requestPermission: () => void
  mode: NotifMode
  setMode: (m: NotifMode) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const glyph = permission === 'denied' ? '🔕' : '🔔'
  const btnTitle =
    permission === 'granted'
      ? 'デスクトップ通知の設定'
      : permission === 'denied'
        ? 'デスクトップ通知はブラウザの設定でブロックされています'
        : 'デスクトップ通知'

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={btnTitle}
        className={`rounded p-1.5 ${
          permission === 'granted'
            ? 'text-accent-600 hover:bg-surface-muted'
            : permission === 'denied'
              ? 'text-ink-subtle opacity-50 hover:bg-surface-muted'
              : 'text-ink-subtle hover:bg-surface-muted hover:text-ink-muted'
        }`}
      >
        {glyph}
      </button>

      {open && (
        // サイドバー（画面左端固定・幅260px）の中に収める。ボタンはヘッダー内で位置が
        // 変わりうるため、ボタン基準の absolute ではなく画面左端基準の fixed で置く。
        <div className="fixed left-2 top-14 z-30 w-[244px] rounded-lg border border-line bg-surface p-3 text-[12px] shadow-lg">
          <div className="mb-2 font-bold text-ink">デスクトップ通知</div>

          {permission === 'default' && (
            <>
              <p className="mb-2 leading-relaxed text-ink-subtle">
                他のタブやアプリを見ている間、またはブラウザを閉じている間に届いた新着を、
                OSの通知で知らせます（対応ブラウザのみ、閉じている間の通知はベストエフォートです）。
              </p>
              <button
                type="button"
                onClick={() => {
                  requestPermission()
                  setOpen(false)
                }}
                className="w-full rounded-md bg-accent-600 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-accent-700"
              >
                通知を有効にする
              </button>
            </>
          )}

          {permission === 'denied' && (
            <p className="leading-relaxed text-ink-subtle">
              このサイトの通知がブラウザ側でブロックされています。ブラウザのサイト設定から
              「通知」を許可すると使えるようになります。
            </p>
          )}

          {permission === 'granted' && (
            <>
              <div className="mb-1.5 text-ink-subtle">通知する新着</div>
              <label className="mb-1 flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-surface-muted">
                <input
                  type="radio"
                  name="notif-mode"
                  className="mt-0.5"
                  checked={mode === 'all'}
                  onChange={() => setMode('all')}
                />
                <span>
                  <span className="font-semibold text-ink">すべての新着</span>
                  <span className="block text-ink-subtle">所属チャンネルの全メッセージとDM</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-surface-muted">
                <input
                  type="radio"
                  name="notif-mode"
                  className="mt-0.5"
                  checked={mode === 'mentions'}
                  onChange={() => setMode('mentions')}
                />
                <span>
                  <span className="font-semibold text-ink">メンション・DMのみ</span>
                  <span className="block text-ink-subtle">自分が名指しされた発言とDMだけ</span>
                </span>
              </label>
              <p className="mt-2 leading-relaxed text-ink-subtle">
                Kogackのタブを開いて操作している間は通知しません（サイドバーの未読バッジで分かるため）。
                ブラウザを閉じている間の通知は対応ブラウザでのみ届きます。
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}
