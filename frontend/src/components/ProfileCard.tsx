import { useEffect, useRef } from 'react'
import { useUserProfile } from '../hooks/useUserProfile'
import { avatarColorFor } from '../lib/avatarColor'

const ROLE_LABELS: Record<string, string> = { admin: 'システム管理者', member: '一般' }
const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'bg-admin-bg text-admin-text',
  member: 'bg-member-bg text-member-text',
}

// S-03発言者アイコン・表示名クリックで開くプロフィールカード（F-40、A-67）。
// アイコン・表示名・メールアドレス・ロールのみ表示し、所属チャンネル等は含めない
// （非公開チャンネルの存在が間接的に漏れるのを避けるため。基本設計書5.21節「設計判断」）。
// メンションと異なりS-03専用として設計書に書かれているが、MessageListはS-03・S-04・DM会話の
// 共通コンポーネントであり、A-67に閲覧側の絞り込みが無い（誰でも参照可）ため、DM会話でも
// 自然に動作する拡張として実装する（スレッドをDM発言にも対応させた際と同じ考え方）。
export default function ProfileCard({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { profile, error } = useUserProfile(userId)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute left-5 top-9 z-40 w-[250px] rounded-xl border border-line-strong bg-surface p-4 text-left shadow-[0_12px_30px_rgba(16,24,40,0.18)]"
    >
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
        </>
      )}
    </div>
  )
}
