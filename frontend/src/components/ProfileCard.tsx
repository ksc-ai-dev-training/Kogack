import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { useUserProfile } from '../hooks/useUserProfile'
import { useMe } from '../hooks/useMe'
import { useDms } from '../hooks/useDms'
import { apiFetch, ApiError } from '../lib/api'
import { avatarColorFor } from '../lib/avatarColor'
import { currentUiZoomScale } from '../lib/uiZoom'
import { useToast } from './Toast'

const ROLE_LABELS: Record<string, string> = { admin: 'システム管理者', member: '一般' }
const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'bg-admin-bg text-admin-text',
  member: 'bg-member-bg text-member-text',
}

const CARD_WIDTH = 250
const CARD_HEIGHT_ESTIMATE = 240 // 実測前の見積もり（下開き/上開きの判定用途のみ、描画内容の高さとは独立。DMボタン分を含む）

// S-03発言者アイコン・表示名クリックで開くプロフィールカード（F-40、A-67）。
// アイコン・表示名・メールアドレス・ロールのみ表示し、所属チャンネル等は含めない
// （非公開チャンネルの存在が間接的に漏れるのを避けるため。基本設計書5.21節「設計判断」）。
// メンションと異なりS-03専用として設計書に書かれているが、MessageListはS-03・S-04・DM会話の
// 共通コンポーネントであり、A-67に閲覧側の絞り込みが無い（誰でも参照可）ため、DM会話でも
// 自然に動作する拡張として実装する（スレッドをDM発言にも対応させた際と同じ考え方）。
export default function ProfileCard({
  userId,
  onClose,
  anchor,
}: {
  userId: string
  onClose: () => void
  /** 指定すると document.body へポータル描画し、anchor（クリックした要素のgetBoundingClientRect）を
   * 基準にposition: fixedで配置する。画面下寄りの発言でカードが投稿欄の裏に隠れてしまう問題への対策で、
   * 下に十分な余白が無ければ自動的に上開きに切り替える（MessageList向け）。省略時は従来どおり
   * 親要素基準のabsolute配置（ThreadPanelの元発言ヘッダーなど、常に上部にあり問題が起きない箇所向け） */
  anchor?: DOMRect
}) {
  const { profile, error } = useUserProfile(userId)
  const { me } = useMe()
  const { dms, mutate: mutateDms } = useDms()
  const navigate = useNavigate()
  const toast = useToast()
  const ref = useRef<HTMLDivElement>(null)
  const [startingDm, setStartingDm] = useState(false)

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [onClose])

  // 既存の一対一DMがあればA-17がそのまま再利用するが（参加者集合の完全一致判定）、
  // 先にサイドバーのキャッシュ（useDms）から見つかればAPI呼び出し自体を省略して即遷移する
  // （DmPickerModalのexistingDmWithと同じ考え方。新規開始のみAPIを呼ぶ）
  const goToDm = async () => {
    if (!profile) return
    const existing = dms.find((d) => d.members.length === 1 && d.members[0].id === profile.id)
    if (existing) {
      onClose()
      navigate(`/dms/${existing.id}`)
      return
    }
    setStartingDm(true)
    try {
      const dm = await apiFetch<{ id: string }>('/api/dms', {
        method: 'POST',
        body: JSON.stringify({ member_user_ids: [profile.id] }),
      })
      await mutateDms()
      onClose()
      navigate(`/dms/${dm.id}`)
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'DMの開始に失敗しました', 'error')
    } finally {
      setStartingDm(false)
    }
  }

  const content = (
    <>
      <button
        type="button"
        onClick={onClose}
        title="閉じる"
        className="absolute right-2 top-2 text-ink-subtle hover:text-ink-muted"
      >
        ✕
      </button>
      {error ? (
        <p className="text-xs text-ink-subtle">読み込みに失敗しました</p>
      ) : !profile ? (
        <p className="text-xs text-ink-subtle">読み込み中...</p>
      ) : (
        <>
          {profile.picture_url ? (
            <img
              src={profile.picture_url}
              alt=""
              referrerPolicy="no-referrer"
              className="mb-2 h-12 w-12 rounded-full object-cover"
            />
          ) : (
            <div
              className="mb-2 flex h-12 w-12 items-center justify-center rounded-full text-base font-bold text-white"
              style={{ background: avatarColorFor(profile.id) }}
            >
              {profile.name.slice(0, 1)}
            </div>
          )}
          <div className="text-sm font-bold text-ink">{profile.name}</div>
          <div className="mt-0.5 text-xs text-ink-subtle">{profile.email}</div>
          <div className="mt-2">
            <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${ROLE_BADGE_CLASS[profile.role]}`}>
              {ROLE_LABELS[profile.role]}
            </span>
          </div>
          {me && profile.id !== me.id && (
            <button
              type="button"
              disabled={startingDm}
              onClick={goToDm}
              className="mt-3 w-full rounded-lg border border-line-strong px-3 py-1.5 text-xs font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700 disabled:opacity-50"
            >
              💬 DMを送る
            </button>
          )}
        </>
      )}
    </>
  )

  if (anchor) {
    // ユーザーからの報告「画面を最大化し文字サイズを大/特大にすると、リアクション一覧（同じ
    // anchor+position:fixed方式のEmojiGridPopover）が画面外にはみ出す」と同種のバグをこちらにも
    // 発見したため同じ考え方で修正した（詳細な原理はEmojiGridPopover・currentUiZoomScaleのコメント
    // 参照）。anchorはUI全体ズーム（lib/uiZoom.ts）適用後の実際の画面座標を返すが、
    // CARD_WIDTH/CARD_HEIGHT_ESTIMATEはカード自身のCSS px指定を書いた定数のため、実際の画面上の
    // footprint（scale倍）より小さく見積もってしまう分をscaleを掛けて補正する。さらにこのカード
    // 自身もズーム済みsubtreeの子孫であるため、`style.left`等に代入する値はブラウザによって
    // 描画時に「もう一度」scale倍されてしまう（実機検証で確認済み）ため、計算した画面上の実座標を
    // scaleで割り戻してから代入する
    const scale = currentUiZoomScale()
    const marginPx = 6 * scale
    const edgePaddingPx = 8 * scale
    const widthPx = CARD_WIDTH * scale
    const heightEstimatePx = CARD_HEIGHT_ESTIMATE * scale
    const openUpward = anchor.bottom + heightEstimatePx > window.innerHeight
    const leftOnScreen = Math.min(Math.max(anchor.left, edgePaddingPx), window.innerWidth - widthPx - edgePaddingPx)
    const style: CSSProperties = {
      position: 'fixed',
      left: leftOnScreen / scale,
      ...(openUpward
        ? { bottom: (window.innerHeight - anchor.top + marginPx) / scale }
        : { top: (anchor.bottom + marginPx) / scale }),
    }
    return createPortal(
      <div
        ref={ref}
        style={style}
        className="z-50 w-[250px] rounded-xl border border-line-strong bg-surface p-4 text-left shadow-[0_12px_30px_rgba(16,24,40,0.18)]"
      >
        {content}
      </div>,
      document.body,
    )
  }

  return (
    <div
      ref={ref}
      className="absolute left-5 top-9 z-40 w-[250px] rounded-xl border border-line-strong bg-surface p-4 text-left shadow-[0_12px_30px_rgba(16,24,40,0.18)]"
    >
      {content}
    </div>
  )
}
