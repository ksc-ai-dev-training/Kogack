import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { useChannel, useChannels } from '../hooks/useChannels'
import { useChannelMembers } from '../hooks/useChannelMembers'
import { useUserProfile } from '../hooks/useUserProfile'
import { useMe } from '../hooks/useMe'
import { apiFetch, ApiError } from '../lib/api'
import { avatarColorFor } from '../lib/avatarColor'
import { useToast } from './Toast'
import { useConfirm } from './ui/ConfirmDialog'
import type { UserSearchResult } from '../types'

// 補足03 メンバー一覧＋チャンネル情報（S-03ヘッダーの参加人数／チャンネル名から開くモーダル）。
// 「メンバー」タブはchadmin/adminバッジを表示し、非公開チャンネルのみ「＋メンバーを追加」
// （A-08招待。参加者なら誰でも追加できる、F-34）を表示する。管理者（chadmin）の変更はここでは
// 行わず、S-06チャンネル設定に一本化する。「チャンネル情報」タブは説明・作成者・作成日時と、
// このチャンネルから退出する操作（A-72、新規）を提供する。
export default function MembersModal({
  channelId,
  initialTab = 'members',
  onClose,
}: {
  channelId: string
  initialTab?: 'info' | 'members'
  onClose: () => void
}) {
  const navigate = useNavigate()
  const { me } = useMe()
  const { channel } = useChannel(channelId)
  const { members, mutate: mutateMembers } = useChannelMembers(channelId)
  const { mutate: mutateChannelsList } = useChannels()
  const { profile: creator } = useUserProfile(channel?.created_by)
  const toast = useToast()
  const confirm = useConfirm()

  const canRemoveMembers = !!channel && (channel.is_channel_admin || me?.role === 'admin')
  const [tab, setTab] = useState<'info' | 'members'>(initialTab)
  const [leaving, setLeaving] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [addQuery, setAddQuery] = useState('')
  const [addResults, setAddResults] = useState<UserSearchResult[]>([])

  const q = query.trim().toLowerCase()
  const filtered = members.filter(
    (m) => m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q),
  )
  const memberIds = new Set(members.map((m) => m.id))

  useEffect(() => {
    if (!adding) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch<{ items: UserSearchResult[] }>(
          `/api/users?q=${encodeURIComponent(addQuery)}`,
        )
        if (!cancelled) setAddResults(res.items.filter((u) => !memberIds.has(u.id)))
      } catch {
        // 検索失敗時は一覧を維持する
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [adding, addQuery, members.length])

  const addMember = async (userId: string) => {
    try {
      await apiFetch(`/api/channels/${channelId}/members`, {
        method: 'POST',
        body: JSON.stringify({ user_id: userId }),
      })
      await mutateMembers()
      setAdding(false)
      setAddQuery('')
      toast('メンバーを追加しました')
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '追加に失敗しました', 'error')
    }
  }

  const leaveChannel = async () => {
    if (!channel) return
    const ok = await confirm({
      title: 'チャンネルを退出',
      message: channel.is_public
        ? `# ${channel.name} から退出しますか？`
        : `# ${channel.name} から退出しますか？\n非公開チャンネルのため、再度参加するには他の参加者による招待が必要です。`,
      confirmLabel: '退出する',
      danger: true,
    })
    if (!ok) return
    setLeaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/members/me`, { method: 'DELETE' })
      await mutateChannelsList()
      toast('チャンネルを退出しました')
      onClose()
      navigate('/', { replace: true })
    } catch (e) {
      toast(e instanceof Error ? e.message : '退出に失敗しました', 'error')
      setLeaving(false)
    }
  }

  const removeMember = async (userId: string, name: string) => {
    const ok = await confirm({
      title: 'メンバーを退出させる',
      message: `${name} さんをこのチャンネルから退出させますか？`,
      confirmLabel: '退出させる',
      danger: true,
    })
    if (!ok) return
    setRemovingId(userId)
    try {
      await apiFetch(`/api/channels/${channelId}/members/${userId}`, { method: 'DELETE' })
      await mutateMembers()
      toast('メンバーを退出させました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '退出させるのに失敗しました', 'error')
    } finally {
      setRemovingId(null)
    }
  }

  const subLabel = channel
    ? `${channel.is_public ? '#' : '🔒'} ${channel.name}${channel.is_public ? '' : '（非公開）'}・ ${members.length}名`
    : ''

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,24,33,0.45)] p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-[420px] flex-col overflow-hidden rounded-[14px] bg-surface shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-[22px] pb-1 pt-4.5">
          <div className="flex-1">
            <h2 className="text-[15.5px] font-bold text-ink">{channel?.name ?? '読み込み中...'}</h2>
            <div className="mt-0.5 text-[11.5px] text-ink-subtle">{subLabel}</div>
          </div>
          <button onClick={onClose} className="text-ink-subtle hover:text-ink-muted">
            ✕
          </button>
        </div>

        <div className="mx-[22px] mt-3 flex gap-0 border-b border-line">
          <button
            type="button"
            onClick={() => setTab('info')}
            className={`mr-5.5 border-b-2 pb-2 text-[13px] font-semibold ${
              tab === 'info' ? 'border-accent-600 text-accent-700' : 'border-transparent text-ink-subtle'
            }`}
          >
            チャンネル情報
          </button>
          <button
            type="button"
            onClick={() => setTab('members')}
            className={`border-b-2 pb-2 text-[13px] font-semibold ${
              tab === 'members' ? 'border-accent-600 text-accent-700' : 'border-transparent text-ink-subtle'
            }`}
          >
            メンバー
          </button>
        </div>

        {tab === 'info' && channel && (
          <div className="overflow-y-auto px-[22px] py-4">
            <div className="mb-4">
              <div className="mb-1 text-[11px] font-bold text-ink-muted">説明</div>
              <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
                {channel.topic || 'このチャンネルには説明が設定されていません。'}
              </div>
            </div>
            <div className="mb-4">
              <div className="mb-1 text-[11px] font-bold text-ink-muted">公開範囲</div>
              <div className="text-[13px] text-ink">{channel.is_public ? '公開チャンネル' : '非公開チャンネル'}</div>
            </div>
            <div className="mb-4">
              <div className="mb-1 text-[11px] font-bold text-ink-muted">作成者</div>
              <div className="text-[13px] text-ink">{creator?.name ?? '読み込み中...'}</div>
            </div>
            <div className="mb-5">
              <div className="mb-1 text-[11px] font-bold text-ink-muted">作成日時</div>
              <div className="text-[13px] text-ink">
                {new Date(channel.created_at).toLocaleString('ja-JP', {
                  year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit',
                })}
              </div>
            </div>
            <button
              type="button"
              disabled={leaving}
              onClick={leaveChannel}
              className="w-full rounded-lg border border-danger-border bg-danger-bg px-4 py-2 text-[13px] font-bold text-danger-text disabled:opacity-40"
            >
              このチャンネルを退出する
            </button>
          </div>
        )}

        {tab === 'members' && (adding ? (
          <>
            <div className="mx-[22px] mb-2 mt-3 flex items-center gap-2 rounded-lg border border-line-strong px-3 py-2">
              <input
                value={addQuery}
                onChange={(e) => setAddQuery(e.target.value)}
                placeholder="氏名またはメールアドレスで検索"
                className="w-full text-[12.5px] text-ink outline-none placeholder:text-ink-subtle"
                autoFocus
              />
            </div>
            <div className="max-h-72 overflow-y-auto px-2.5 py-1">
              {addResults.length === 0 && (
                <p className="px-3 py-2 text-sm text-ink-subtle">該当する利用者がいません。</p>
              )}
              {addResults.map((u) => {
                const disabled = !u.is_active
                return (
                  <div
                    key={u.id}
                    className={`flex items-center gap-3 rounded-[9px] px-3 py-[9px] ${
                      disabled ? 'opacity-55' : 'hover:bg-surface-subtle'
                    }`}
                  >
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
                    {disabled ? (
                      <span className="flex-none text-[10.5px] text-ink-subtle">無効化済み</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => addMember(u.id)}
                        className="flex-none rounded-md border border-line-strong px-3 py-1 text-xs font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700"
                      >
                        追加
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="border-t border-line px-[22px] py-3">
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="text-xs text-accent-700 hover:underline"
              >
                ← メンバー一覧に戻る
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mx-[22px] mb-2 mt-3 flex items-center gap-2 rounded-lg border border-line-strong px-3 py-2">
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="flex-none">
                <circle cx="9" cy="9" r="6.2" stroke="#8a8f98" strokeWidth="1.6" />
                <path d="M17 17l-3.6-3.6" stroke="#8a8f98" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="メンバーを検索"
                className="w-full text-[12.5px] text-ink outline-none placeholder:text-ink-subtle"
              />
            </div>

            {channel && !channel.is_public && (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="mx-[22px] mb-2 flex-none self-start rounded-[7px] bg-accent-600 px-3.5 py-1.5 text-xs font-bold text-white"
              >
                ＋ メンバーを追加
              </button>
            )}

            <div className="max-h-72 overflow-y-auto px-2.5 py-1">
              {filtered.map((m) => (
                <div key={m.id} className="flex items-center gap-3 rounded-[9px] px-3 py-[9px] hover:bg-surface-subtle">
                  {m.picture_url ? (
                    <img
                      src={m.picture_url}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="h-8 w-8 flex-none rounded-full object-cover"
                    />
                  ) : (
                    <div
                      className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-xs font-bold text-white"
                      style={{ background: avatarColorFor(m.id) }}
                    >
                      {m.name.slice(0, 1)}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className={`flex flex-wrap items-center gap-1.5 text-[13px] font-bold text-ink ${m.is_active ? '' : 'text-ink-subtle line-through'}`}>
                      {m.name}
                      {m.is_channel_admin && (
                        <span className="rounded bg-chadmin-bg px-1.5 py-0.5 text-[10px] font-bold text-chadmin-text">
                          chadmin
                        </span>
                      )}
                      {m.role === 'admin' && (
                        <span className="rounded bg-admin-bg px-1.5 py-0.5 text-[10px] font-bold text-admin-text">
                          admin
                        </span>
                      )}
                      {!m.is_active && (
                        <span className="rounded bg-off-bg px-1.5 py-0.5 text-[10px] font-bold text-off-text">
                          無効
                        </span>
                      )}
                    </div>
                  </div>
                  {canRemoveMembers && m.id !== me?.id && (
                    <button
                      type="button"
                      disabled={removingId === m.id}
                      onClick={() => removeMember(m.id, m.name)}
                      className="flex-none rounded-md border border-line-strong px-2.5 py-1 text-[11px] font-semibold text-ink-muted hover:border-danger-border hover:text-danger-text disabled:opacity-40"
                    >
                      退出させる
                    </button>
                  )}
                </div>
              ))}
              {filtered.length === 0 && (
                <p className="px-3 py-2 text-sm text-ink-subtle">該当するメンバーがいません。</p>
              )}
            </div>

            <div className="border-t border-line px-[22px] py-3 text-[11px] leading-relaxed text-ink-subtle">
              チャンネル管理者（chadmin）の変更はチャンネル設定から行います。
              {channel && !channel.is_public && (
                <>
                  <br />
                  「＋メンバーを追加」は非公開チャンネルのみ表示され、参加者なら誰でも他の利用者を追加できます。
                </>
              )}
              {canRemoveMembers && (
                <>
                  <br />
                  「退出させる」はチャンネル管理者・システム管理者のみ表示されます。最後のチャンネル管理者は退出させられません。
                </>
              )}
            </div>
          </>
        ))}
      </div>
    </div>
  )
}
