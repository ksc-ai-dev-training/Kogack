import { useEffect, useMemo, useRef, useState } from 'react'
import { useMe } from '../hooks/useMe'
import { apiFetch, uploadIcon } from '../lib/api'
import { avatarColorFor } from '../lib/avatarColor'
import { useToast } from './Toast'
import type { Me } from '../types'

const MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

// 補足06 プロフィールを編集（F-37 画像アップロード・F-39 表示名変更）。画面モックアップでは
// トップバー右のユーザーメニューから開くが、このアプリの実装はサイドバー下部にユーザー情報を
// まとめて表示する構成のため、そこをユーザーメニュー相当として開く（Layout.tsx）。
export default function ProfileEditModal({ me, onClose }: { me: Me; onClose: () => void }) {
  const { mutate: mutateMe } = useMe()
  const toast = useToast()
  const [name, setName] = useState(me.name)
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 選択したファイルのプレビュー用Object URL。生成自体はレンダー中に行い、破棄（副作用）だけを
  // クリーンアップ関数に任せる（画面設計11.6節「プレビューのObject URLはuseEffectのクリーンアップで解放する」）
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const pickFile = (f: File | null) => {
    if (!f) return
    if (!ALLOWED_TYPES.includes(f.type)) {
      toast('JPEG・PNG・WebP形式のみアップロードできます', 'error')
      return
    }
    if (f.size > MAX_BYTES) {
      toast('ファイルサイズは5MBまでです', 'error')
      return
    }
    setFile(f)
  }

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast('表示名を入力してください', 'error')
      return
    }
    setSaving(true)
    try {
      // A-61→A-62（画像を選択している場合のみアップロードしてからURLを反映。基本設計書「設計判断」）
      const pictureUrl = file ? (await uploadIcon(file)).url : undefined
      const updated = await apiFetch<Me>('/api/users/me', {
        method: 'PUT',
        body: JSON.stringify({ name: trimmed, picture_url: pictureUrl }),
      })
      await mutateMe(updated, { revalidate: false })
      toast('プロフィールを更新しました')
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : '更新に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,24,33,0.45)] p-6"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-[380px] flex-col overflow-hidden rounded-[14px] bg-surface shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-[22px] pb-1 pt-4.5">
          <h2 className="flex-1 text-[15.5px] font-bold text-ink">プロフィールを編集</h2>
          <button type="button" onClick={onClose} className="text-ink-subtle hover:text-ink-muted">
            ✕
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-[22px] pb-1 pt-4.5 text-center">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt=""
              className="mx-auto mb-3.5 h-24 w-24 rounded-full border-[3px] border-surface object-cover shadow-[0_0_0_1px_var(--color-line-strong)]"
            />
          ) : me.picture_url ? (
            <img
              src={me.picture_url}
              alt=""
              referrerPolicy="no-referrer"
              className="mx-auto mb-3.5 h-24 w-24 rounded-full border-[3px] border-surface object-cover shadow-[0_0_0_1px_var(--color-line-strong)]"
            />
          ) : (
            <div
              className="mx-auto mb-3.5 flex h-24 w-24 items-center justify-center rounded-full text-[30px] font-bold text-white"
              style={{ background: avatarColorFor(me.id) }}
            >
              {(name || '?').slice(0, 1)}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg bg-accent-600 px-4.5 py-2 text-[13px] font-bold text-white"
          >
            画像をアップロード
          </button>
          <div className="mt-2 text-[11px] leading-relaxed text-ink-subtle">
            JPEG・PNG・WebP、5MBまで。アップロードした画像は他の利用者にも表示されます。
          </div>

          {file && (
            <div className="my-4 flex items-center gap-2.5 rounded-lg border border-line bg-surface-subtle px-3 py-2 text-left">
              <img src={previewUrl ?? undefined} alt="" className="h-[34px] w-[34px] flex-none rounded-full object-cover" />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{file.name}</span>
              <span className="flex-none text-[10.5px] text-ink-subtle">{(file.size / 1024 / 1024).toFixed(1)}MB</span>
            </div>
          )}

          <div className="mt-4.5 text-left">
            <label className="mb-1.5 block text-xs font-bold text-ink-muted">表示名</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              className="w-full rounded-lg border-[1.5px] border-line-strong px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
            />
            <div className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">
              社員番号・かな/ローマ字表記などを含めてもかまいません。同じ表示名の利用者が同じチャンネルにいる場合、発言者表示に自動でメールアドレスが併記されます。
            </div>
          </div>

          <div className="mt-4.5 text-left">
            <label className="mb-1.5 block text-xs font-bold text-ink-muted">メールアドレス</label>
            <div className="w-full rounded-lg border-[1.5px] border-line bg-surface-muted px-3 py-2 text-[13.5px] text-ink-subtle">
              {me.email}
            </div>
            <div className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">
              Googleアカウントの情報を表示しており、この画面からは変更できません。
            </div>
          </div>

          <p className="mb-1 mt-4.5 border-t border-line pt-3 text-left text-[11px] leading-relaxed text-ink-subtle">
            表示名は初回ログイン時にGoogleアカウントの氏名で初期化されますが、変更後はGoogle側の氏名更新を自動的には反映しません。画像も同様に、初回ログイン時にGoogleのプロフィール写真で初期化された後は、ここで変更するまでGoogle側の写真更新を反映しません。
          </p>
        </div>

        <div className="px-[22px] pb-5 pt-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink-muted"
            >
              キャンセル
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={save}
              className="flex-1 rounded-lg bg-accent-600 px-3 py-2 text-[13px] font-bold text-white disabled:opacity-40"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
