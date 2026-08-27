import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useChannels } from '../hooks/useChannels'
import { apiFetch, ApiError } from '../lib/api'
import { useToast } from './Toast'

// 補足01 チャンネルに参加／作成（このスライスは公開チャンネルのみ。非公開＝F-34は次スライス）
export default function JoinChannelModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'join' | 'create'>('join')
  const { joinable, mutate } = useChannels()
  const navigate = useNavigate()
  const toast = useToast()

  const [name, setName] = useState('')
  const [topic, setTopic] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const filteredJoinable = joinable.filter((c) => c.name.toLowerCase().includes(query.trim().toLowerCase()))

  const join = async (channelId: string) => {
    try {
      await apiFetch(`/api/channels/${channelId}/members`, { method: 'POST' })
      await mutate()
      onClose()
      navigate(`/channels/${channelId}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : '参加に失敗しました', 'error')
    }
  }

  const create = async () => {
    setFormError(null)
    if (!name.trim()) {
      setFormError('チャンネル名を入力してください')
      return
    }
    setBusy(true)
    try {
      const created = await apiFetch<{ id: string }>('/api/channels', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), topic: topic.trim() || null, is_public: isPublic }),
      })
      await mutate()
      onClose()
      navigate(`/channels/${created.id}`)
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : '作成に失敗しました')
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
        className="flex max-h-[82vh] w-full max-w-[480px] flex-col overflow-hidden rounded-[14px] bg-surface shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-[22px] pt-4.5">
          <h2 className="flex-1 text-[15.5px] font-bold text-ink">チャンネル</h2>
          <button onClick={onClose} className="text-ink-subtle hover:text-ink-muted">
            ✕
          </button>
        </div>

        <div className="mx-[22px] mt-3.5 flex gap-0 border-b border-line">
          <button
            onClick={() => setTab('join')}
            className={`mr-5.5 border-b-2 pb-2 text-[13px] font-semibold ${
              tab === 'join' ? 'border-accent-600 text-accent-700' : 'border-transparent text-ink-subtle'
            }`}
          >
            参加する
          </button>
          <button
            onClick={() => setTab('create')}
            className={`border-b-2 pb-2 text-[13px] font-semibold ${
              tab === 'create' ? 'border-accent-600 text-accent-700' : 'border-transparent text-ink-subtle'
            }`}
          >
            作成する
          </button>
        </div>

        {tab === 'join' ? (
          <div className="overflow-y-auto px-3 py-3">
            <div className="mx-[9px] mb-2 flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5">
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="flex-none">
                <circle cx="9" cy="9" r="6.2" stroke="#8a8f98" strokeWidth="1.6" />
                <path d="M17 17l-3.6-3.6" stroke="#8a8f98" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="チャンネル名で検索"
                className="w-full text-[13px] text-ink outline-none placeholder:text-ink-subtle"
                autoFocus
              />
            </div>
            <div className="max-h-72 overflow-y-auto">
              {joinable.length === 0 && (
                <p className="px-3 py-2 text-sm text-ink-subtle">参加可能な公開チャンネルはありません。</p>
              )}
              {joinable.length > 0 && filteredJoinable.length === 0 && (
                <p className="px-3 py-2 text-sm text-ink-subtle">該当するチャンネルがありません。</p>
              )}
              {filteredJoinable.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-3 rounded-[9px] px-3 py-2.5 hover:bg-surface-subtle"
                >
                  <div className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] bg-surface-muted text-base text-ink-subtle">
                    #
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-bold text-ink">{c.name}</div>
                    {c.topic && <div className="truncate text-[11.5px] text-ink-subtle">{c.topic}</div>}
                  </div>
                  <button
                    type="button"
                    onClick={() => join(c.id)}
                    className="flex-none rounded-[7px] bg-accent-600 px-3.5 py-1.5 text-xs font-bold text-white"
                  >
                    参加
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="overflow-y-auto px-[22px] py-4">
            <div className="mb-4">
              <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">チャンネル名</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例: 経理連絡"
                className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-subtle"
                maxLength={256}
              />
            </div>
            <div className="mb-4">
              <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">説明（任意）</label>
              <input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="このチャンネルの目的を入力"
                className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-subtle"
              />
            </div>
            <div className="mb-4">
              <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">公開範囲</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setIsPublic(true)}
                  className={`flex-1 rounded-[10px] border px-3 py-2.5 text-left ${
                    isPublic ? 'border-accent-600 bg-accent-50' : 'border-line-strong'
                  }`}
                >
                  <div className={`flex items-center gap-1.5 text-[12.5px] font-bold ${isPublic ? 'text-accent-700' : 'text-ink'}`}>
                    ＃ 公開
                  </div>
                  <div className="mt-0.5 text-[11px] leading-snug text-ink-subtle">全社員が検索して即時参加できます</div>
                </button>
                <button
                  type="button"
                  onClick={() => setIsPublic(false)}
                  className={`flex-1 rounded-[10px] border px-3 py-2.5 text-left ${
                    !isPublic ? 'border-accent-600 bg-accent-50' : 'border-line-strong'
                  }`}
                >
                  <div className={`flex items-center gap-1.5 text-[12.5px] font-bold ${!isPublic ? 'text-accent-700' : 'text-ink'}`}>
                    🔒 非公開
                  </div>
                  <div className="mt-0.5 text-[11px] leading-snug text-ink-subtle">参加者が追加した人だけが参加できます</div>
                </button>
              </div>
            </div>
            {formError && <p className="mb-3 text-sm text-danger-text">{formError}</p>}
            <button
              onClick={create}
              disabled={busy}
              className="w-full rounded-[8px] bg-accent-600 py-2.5 text-[13px] font-bold text-white disabled:opacity-40"
            >
              チャンネルを作成
            </button>
            <p className="mt-2 text-[11px] leading-relaxed text-ink-subtle">
              作成すると、あなたが自動的にこのチャンネルのチャンネル管理者（chadmin）になります。
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
