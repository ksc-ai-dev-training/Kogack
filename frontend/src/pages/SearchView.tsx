import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useSearch } from '../hooks/useSearch'
import type { SearchResultItem } from '../types'

function formatDateTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('ja-JP', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

// S-05 横断検索（このスライスはメッセージ検索のみ。F-42のin:/from:/with:等のモディファイア
// オートコンプリートUI、タブ切替、ファイル・ドキュメント根拠検索は未実装）
export default function SearchView() {
  const [searchParams, setSearchParams] = useSearchParams()
  const q = searchParams.get('q') ?? ''
  const [input, setInput] = useState(q)
  const { result, isLoading } = useSearch(q)
  const navigate = useNavigate()

  const submit = () => {
    const next = new URLSearchParams(searchParams)
    if (input.trim()) next.set('q', input.trim())
    else next.delete('q')
    setSearchParams(next)
  }

  const openResult = (item: SearchResultItem) => {
    if (item.channel_id) navigate(`/channels/${item.channel_id}`)
    else if (item.dm_id) navigate(`/dms/${item.dm_id}`)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-none px-7 pt-4">
        <div className="flex gap-2">
          <div className="flex w-full max-w-md items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="flex-none">
              <circle cx="9" cy="9" r="6.2" stroke="#8a8f98" strokeWidth="1.6" />
              <path d="M17 17l-3.6-3.6" stroke="#8a8f98" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder="メッセージを検索"
              className="w-full text-[13px] text-ink outline-none placeholder:text-ink-subtle"
              autoFocus
            />
          </div>
          <button
            type="button"
            onClick={submit}
            className="flex-none rounded-[7px] bg-accent-600 px-4 py-2 text-[13px] font-bold text-white"
          >
            検索
          </button>
        </div>

        {q && result && (
          <h1 className="mt-4 text-[16px] text-ink">
            <span className="text-accent-700">「{q}」</span>の検索結果
            <span className="ml-1.5 text-xs font-normal text-ink-subtle">{result.counts.message}件</span>
          </h1>
        )}
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-accent-100 bg-accent-50 px-3 py-2.5 text-xs text-accent-700">
          <span>🔍</span>
          <span>
            検索対象は、あなたが参加しているチャンネル・DMの発言に限定されます。
            <span className="mt-0.5 block text-[11px] text-ink-subtle">
              ファイル・ドキュメント根拠の検索、in:/from:等の検索条件は未実装です。
            </span>
          </span>
        </div>
      </div>

      <div className="mt-2 flex-1 overflow-y-auto pb-6">
        {!q && <p className="px-7 pt-4 text-sm text-ink-subtle">検索語を入力してください。</p>}
        {q && isLoading && <p className="px-7 pt-4 text-sm text-ink-subtle">検索中...</p>}
        {q && result && (
          <>
            {result.items.length === 0 && (
              <p className="px-7 pt-4 text-sm text-ink-subtle">該当する結果がありません。</p>
            )}
            {result.items.length > 0 && (
              <div className="mx-7 mt-3 text-[11px] font-bold tracking-wide text-ink-subtle">メッセージ</div>
            )}
            {result.items.map((item) => (
              <button
                key={item.message_id}
                type="button"
                onClick={() => openResult(item)}
                className="flex w-full gap-3 border-b border-surface-muted px-7 py-2.5 text-left hover:bg-surface-subtle"
              >
                <div className="w-[150px] flex-none pt-px text-[11.5px] font-semibold text-ink">
                  {item.channel_name ? `# ${item.channel_name}` : (item.dm_label ?? 'DM')}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-[7px]">
                    <span className="text-[13px] font-bold text-ink">{item.sender_display_name ?? '(不明)'}</span>
                    <span className="text-[11px] text-ink-subtle">{formatDateTime(item.posted_at)}</span>
                  </div>
                  <div className="mt-0.5 text-[13px] leading-[1.7] text-ink">{item.excerpt}</div>
                </div>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
