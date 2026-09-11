import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../lib/api'
import { useToast } from './Toast'
import type { ChannelNotifMode } from '../types'

const LABELS: Record<ChannelNotifMode, string> = {
  default: '既定に従う',
  all: 'すべて',
  mentions: 'メンションのみ',
  off: 'オフ（ミュート）',
}

// チャンネル会話画面ヘッダーの通知設定ボタン（ユーザーからの明示的な要望「チャンネルごとに
// 通知設定できる機能を付けられる？」、2026-09-11）。サイドバーのNotificationSettingsButton.tsx
// （全体設定、画面左端固定のためfixed配置）とは異なり、こちらは会話画面ヘッダー（overflow
// クリップの無いflex-none領域）に出るボタンなので、ボタン基準のabsolute配置で足りる。
// 4択（既定に従う/すべて/メンションのみ/オフ）のうち「既定に従う」はA-62のusers.notif_mode
// （全体設定）にそのまま従う。オフ（ミュート）を選んだ場合のみ、サイドバーの未読バッジ・
// 太字表示も抑える（Layout.tsx側の扱い、ユーザーが選んだ推奨案どおり）。
export default function ChannelNotifButton({
  channelId,
  mode,
  onChanged,
}: {
  channelId: string
  mode: ChannelNotifMode
  onChanged: (mode: ChannelNotifMode) => void
}) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const toast = useToast()

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const muted = mode === 'off'
  const glyph = muted ? '🔕' : '🔔'

  const select = async (next: ChannelNotifMode) => {
    if (next === mode) {
      setOpen(false)
      return
    }
    const prev = mode
    onChanged(next) // 楽観的更新（保存を待たずサイドバーのバッジ抑制等に即反映）
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/notif-mode`, {
        method: 'PUT',
        body: JSON.stringify({ notif_mode: next }),
      })
    } catch (e) {
      onChanged(prev)
      toast(e instanceof Error ? e.message : '通知設定の保存に失敗しました', 'error')
    } finally {
      setSaving(false)
      setOpen(false)
    }
  }

  return (
    <div ref={wrapRef} className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`このチャンネルの通知: ${LABELS[mode]}`}
        className={`rounded-[7px] border px-2.5 py-1 text-xs font-semibold ${
          muted
            ? 'border-line bg-surface text-ink-subtle opacity-70 hover:bg-surface-subtle'
            : 'border-line text-ink-muted hover:border-line-strong hover:bg-surface-subtle'
        }`}
      >
        {glyph}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1.5 w-[220px] rounded-lg border border-line bg-surface p-2 text-[12px] shadow-lg">
          <div className="mb-1.5 px-1 font-bold text-ink">このチャンネルの通知</div>
          {(['default', 'all', 'mentions', 'off'] as ChannelNotifMode[]).map((v) => (
            <label
              key={v}
              className="mb-0.5 flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-surface-muted"
            >
              <input
                type="radio"
                name={`channel-notif-mode-${channelId}`}
                className="mt-0.5"
                checked={mode === v}
                disabled={saving}
                onChange={() => select(v)}
              />
              <span className="font-semibold text-ink">{LABELS[v]}</span>
            </label>
          ))}
          <p className="mt-1.5 px-1 leading-relaxed text-ink-subtle">
            「既定に従う」以外を選ぶと、このチャンネルに限りデスクトップ通知の設定を上書きします。
            「オフ」はサイドバーの未読バッジも表示しなくなります。
          </p>
        </div>
      )}
    </div>
  )
}
