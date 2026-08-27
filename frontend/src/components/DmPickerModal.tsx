import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useMe } from '../hooks/useMe'
import { useDms } from '../hooks/useDms'
import { apiFetch, ApiError } from '../lib/api'
import { avatarColorFor } from '../lib/avatarColor'
import { useToast } from './Toast'
import type { Dm, UserSearchResult } from '../types'

// 補足02 DM相手を選ぶ（チェックボックス複数選択＋検索＋既存DMタグ＋無効アカウント選択不可）
export default function DmPickerModal({ onClose }: { onClose: () => void }) {
  const { me } = useMe()
  const { dms, mutate: mutateDms } = useDms()
  const navigate = useNavigate()
  const toast = useToast()

  const [q, setQ] = useState('')
  const [results, setResults] = useState<UserSearchResult[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch<{ items: UserSearchResult[] }>(`/api/users?q=${encodeURIComponent(q)}`)
        if (!cancelled) setResults(res.items.filter((u) => u.id !== me?.id))
      } catch {
        // 検索失敗時は一覧を維持する（トースト等は出さず静かに諦める）
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [q, me?.id])

  const existingDmWith = (userId: string): Dm | undefined =>
    dms.find((d) => d.members.length === 1 && d.members[0].id === userId)

  const toggle = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) next.delete(userId)
      else next.add(userId)
      return next
    })
  }

  const selectedNames = results.filter((u) => selected.has(u.id)).map((u) => u.name)

  const start = async () => {
    if (selected.size === 0) return
    setBusy(true)
    try {
      const dm = await apiFetch<{ id: string }>('/api/dms', {
        method: 'POST',
        body: JSON.stringify({ member_user_ids: Array.from(selected) }),
      })
      await mutateDms()
      onClose()
      navigate(`/dms/${dm.id}`)
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '開始に失敗しました', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,24,33,0.45)] p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-[440px] flex-col overflow-hidden rounded-[14px] bg-surface shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-[22px] pb-1 pt-4.5">
          <h2 className="flex-1 text-[15.5px] font-bold text-ink">DM相手を選ぶ</h2>
          <button onClick={onClose} className="text-ink-subtle hover:text-ink-muted">
            ✕
          </button>
        </div>
        <p className="mx-[22px] mb-3 text-xs text-ink-subtle">
          氏名またはメールアドレスで検索してください。1人選べば一対一のDM、2人以上選べばグループDMになります。
        </p>

        <div className="mx-[22px] mb-2 flex items-center gap-2 rounded-lg border-[1.5px] border-accent-600 px-3 py-2 shadow-[0_0_0_3px_var(--color-accent-50)]">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="氏名またはメールアドレスで検索"
            className="w-full text-[12.5px] text-ink outline-none placeholder:text-ink-subtle"
            autoFocus
          />
        </div>

        <div className="max-h-72 overflow-y-auto px-2.5 py-1">
          {results.length === 0 && <p className="px-3 py-2 text-sm text-ink-subtle">該当する利用者がいません。</p>}
          {results.map((u) => {
            const existing = existingDmWith(u.id)
            const disabled = !u.is_active
            const isSelected = selected.has(u.id)
            return (
              <label
                key={u.id}
                className={`flex items-center gap-3 rounded-[9px] px-3 py-[9px] ${
                  disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-surface-subtle'
                }`}
              >
                <span
                  className={`flex h-[17px] w-[17px] flex-none items-center justify-center rounded-[5px] border-[1.6px] text-[11px] text-white ${
                    isSelected ? 'border-accent-600 bg-accent-600' : 'border-line-strong bg-transparent'
                  }`}
                >
                  {isSelected && '✓'}
                </span>
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={isSelected}
                  onChange={() => toggle(u.id)}
                  className="sr-only"
                />
                {u.picture_url ? (
                  <img
                    src={u.picture_url}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="h-8 w-8 flex-none rounded-full object-cover"
                  />
                ) : (
                  <div
                    className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-xs font-bold text-white"
                    style={{ background: avatarColorFor(u.id) }}
                  >
                    {u.name.slice(0, 1)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-[13px] font-bold text-ink ${disabled ? 'line-through' : ''}`}>
                    {u.name}
                  </div>
                  <div className="truncate text-[11px] text-ink-subtle">{u.email}</div>
                </div>
                {disabled && (
                  <span className="flex-none text-right text-[10.5px] leading-snug text-ink-subtle">
                    無効化済み
                  </span>
                )}
                {!disabled && existing && <span className="flex-none text-[10.5px] text-accent-700">DM済み</span>}
              </label>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-[22px] py-3">
          <span className="text-xs text-ink-muted">
            {selected.size > 0 ? (
              <>
                選択中: <strong className="text-accent-700">{selected.size}名</strong>（{selectedNames.join('、')}）
                {selected.size > 1 && ' → グループDM'}
              </>
            ) : (
              '相手を選んでください'
            )}
          </span>
          <button
            onClick={start}
            disabled={busy || selected.size === 0}
            className="flex-none rounded-lg bg-accent-600 px-5 py-2 text-[13px] font-bold text-white disabled:opacity-40"
          >
            DMを開始する
          </button>
        </div>
      </div>
    </div>
  )
}
