import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError, createCustomEmoji, uploadIcon } from '../lib/api'
import { useOverlayClose } from '../hooks/useOverlayClose'
import { useToast } from './Toast'

// カスタム絵文字の新規登録（ユーザーからの明示的な要望「Slackみたいにリアクションスタンプを
// 自分で作成できる機能」、2026-09-17。着手前に「誰が作れるか」「どこで使えるか」を確認し、
// 利用者全員が作成可能・リアクション＋メッセージ本文の両方で使えるという仕様で合意した）。
// MessageList.tsx（EmojiGridPopover内の「＋」）・Composer.tsx（投稿欄の絵文字ピッカー内の
// 「＋」）の両方から使う共通コンポーネント。MessageList.tsxはComposer.tsxからEMOJI_LISTを
// importしているため、この逆方向の依存をMessageList.tsx側に置くと循環参照になる——
// 独立したファイルに切り出すことでそれを避けている。
// 画像は既存の汎用アップロードAPI（A-61 uploadIcon、プロフィール画像等と共用）をそのまま
// 再利用し、返ってきた公開URLをnameに紐づけて登録するだけの2段階フローにした（新しい
// ストレージ経路を増やさない設計判断）。
export function AddCustomEmojiModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const overlayClose = useOverlayClose(onClose)
  const toast = useToast()
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 選択したファイルのプレビュー用Object URL（ProfileEditModal.tsxと同じパターン。プレビュー生成は
  // レンダー中に行い、破棄だけをuseEffectのクリーンアップに任せる）
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const submit = async () => {
    if (!name.trim()) {
      toast('絵文字名を入力してください', 'error')
      return
    }
    if (!file) {
      toast('画像を選んでください', 'error')
      return
    }
    setSaving(true)
    try {
      const { url } = await uploadIcon(file)
      await createCustomEmoji(name.trim(), url)
      toast('絵文字を追加しました')
      onCreated()
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '絵文字の追加に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(20,24,33,0.5)] p-6" {...overlayClose}>
      <div
        className="w-full max-w-[360px] rounded-[14px] bg-surface p-4 shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[14px] font-bold text-ink">絵文字を追加</div>
        <label className="mb-1 block text-[11.5px] font-semibold text-ink-muted">名前（半角英数字・_・-、2〜24文字）</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例: party_parrot"
          maxLength={24}
          className="mb-3 w-full rounded-md border border-line-strong px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent-600"
        />
        <label className="mb-1 block text-[11.5px] font-semibold text-ink-muted">画像（JPEG・PNG・WebP、5MBまで）</label>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="mb-2 rounded-md bg-accent-600 px-3 py-1.5 text-[12.5px] font-semibold text-white"
        >
          画像をアップロード
        </button>
        <div className="mb-4">
          {file ? (
            <div className="flex items-center gap-2 rounded-md border border-line bg-surface-subtle px-2.5 py-1.5">
              <img src={previewUrl ?? undefined} alt="" className="h-6 w-6 flex-none rounded object-cover" />
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-ink">{file.name}</span>
              <span className="flex-none text-[10.5px] text-ink-subtle">{(file.size / 1024).toFixed(0)}KB</span>
            </div>
          ) : (
            <span className="text-[11px] text-ink-subtle">まだ選択されていません</span>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line-strong px-3 py-1.5 text-[12.5px] text-ink-muted hover:bg-surface-subtle"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="rounded-md bg-accent-600 px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-40"
          >
            追加する
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
