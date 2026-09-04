import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useChannels } from '../hooks/useChannels'
import { useSearch, searchParamsFor, type SearchQuery } from '../hooks/useSearch'
import { apiFetch } from '../lib/api'
import { avatarColorFor } from '../lib/avatarColor'
import { useToast } from '../components/Toast'
import { Avatar, type AvatarSource } from '../components/MessageList'
import type { SearchResponse, SearchResultItem, UserSearchResult } from '../types'

// 検索結果のsender_*フィールドをAvatarコンポーネントが要求する形へ変換する（ユーザーからの明示的な
// 要望で追加。会話ログ・メンション候補一覧等と同じ「画像優先→種別ごとのフォールバック」表示を
// 検索結果でも再現する）。message_id/attachment_idのどちらかを色付き頭文字の最終フォールバック種に使う
function avatarSourceFor(item: SearchResultItem): AvatarSource {
  return {
    sender_type: item.sender_type ?? 'human',
    sender_user_id: item.sender_user_id,
    sender_name: item.sender_display_name,
    sender_picture_url: item.sender_picture_url,
    bot_icon: item.bot_icon,
    id: item.message_id ?? item.attachment_id ?? '',
  }
}

type ModifierType = 'in' | 'from' | 'with'
type DateModifierType = 'before' | 'after' | 'on' | 'during'
interface ResolvedFilter {
  id: string
  label: string
}
interface Candidate {
  id: string
  label: string
  sublabel?: string
}

const MODIFIER_LABEL: Record<ModifierType, string> = { in: 'チャンネル', from: '投稿者', with: 'DM相手' }
const CHIP_LABEL: Record<ModifierType | DateModifierType, string> = {
  in: 'in', from: 'from', with: 'with', before: 'before', after: 'after', on: 'on', during: 'during',
}

// 検索欄の生文字列とカーソル位置から、直前に確定していないin:/from:/with:トークンがあるかを
// 検出する（F-42、詳細設計書API設計6.5節）。Composer.tsxのdetectMentionQuery（F-41）と全く同じ
// 考え方: トリガー文字列の直前が空白または先頭でなければ開始とみなさず、クエリに空白が
// 混じったら（＝候補選択前に次の語へ進んだら）該当トークンの入力は終わったとみなす。
function detectModifierQuery(
  text: string,
  cursor: number,
): { type: ModifierType; tokenIndex: number; query: string } | null {
  const uptoCursor = text.slice(0, cursor)
  let best: { type: ModifierType; tokenIndex: number; query: string } | null = null
  for (const type of ['in', 'from', 'with'] as ModifierType[]) {
    const needle = `${type}:`
    const idx = uptoCursor.lastIndexOf(needle)
    if (idx === -1) continue
    const before = uptoCursor[idx - 1]
    if (before !== undefined && !/\s/.test(before)) continue
    const query = uptoCursor.slice(idx + needle.length)
    if (/[\s\n]/.test(query)) continue
    if (!best || idx > best.tokenIndex) best = { type, tokenIndex: idx, query }
  }
  return best
}

// URLの検索条件（in/in_label等）から検索欄の初期表示テキストを組み立てる（buildQueryの逆変換）。
// ページ再読み込み・ブラウザの戻る/進むで、確定済みのモディファイアも含めて欄の見た目を復元できる。
function composeInputText(params: URLSearchParams): string {
  const parts: string[] = []
  for (const type of ['in', 'from', 'with'] as ModifierType[]) {
    const label = params.get(`${type}_label`)
    if (label) parts.push(`${type}:${label}`)
  }
  for (const type of ['before', 'after', 'on', 'during'] as DateModifierType[]) {
    const v = params.get(type)
    if (v) parts.push(`${type}:${v}`)
  }
  const q = params.get('q')
  if (q) parts.push(q)
  return parts.join(' ')
}

function composeResolved(params: URLSearchParams): Partial<Record<ModifierType, ResolvedFilter>> {
  const out: Partial<Record<ModifierType, ResolvedFilter>> = {}
  for (const type of ['in', 'from', 'with'] as ModifierType[]) {
    const id = params.get(type)
    const label = params.get(`${type}_label`)
    if (id && label) out[type] = { id, label }
  }
  return out
}

// 検索欄の生文字列を、確定済みのin:/from:/with:（id・ラベルのペア）と組み合わせてA-20への
// クエリパラメータに変換する（詳細設計書API設計6.5節「フロントエンドのトークン分解」）。
// in:/from:/with:は、欄の文字列に確定時と同じ「type:ラベル」の部分文字列がまだ含まれている場合
// のみ有効とする（Composer.tsxのactiveMentionsInと同じ、選択後に手で消した場合の整合性チェック）。
// before:/after:/on:/during:は候補解決が不要なため、その場で正規表現抽出する。
function buildQuery(
  text: string,
  resolved: Partial<Record<ModifierType, ResolvedFilter>>,
): { q: string } & Partial<Record<ModifierType | DateModifierType, string>> {
  let remaining = text
  const out: Partial<Record<ModifierType | DateModifierType, string>> = {}
  for (const type of ['in', 'from', 'with'] as ModifierType[]) {
    const r = resolved[type]
    if (r && remaining.includes(`${type}:${r.label}`)) {
      out[type] = r.id
      remaining = remaining.replace(`${type}:${r.label}`, ' ')
    }
  }
  remaining = remaining.replace(/(before|after|on|during):(\S+)/g, (_match, key: string, value: string) => {
    out[key as DateModifierType] = value
    return ' '
  })
  return { q: remaining.replace(/\s+/g, ' ').trim(), ...out }
}

function formatDateTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('ja-JP', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// 検索欄のフリーテキスト部分（query.q）を検索語に分解する。routers/search.pyの_parse_termsと
// 同じ規則（"…"はフレーズのまま1語、それ以外は空白区切り）でフロント側でも再現し、
// バックエンドが実際にILIKE検索で使った語をそのままハイライト対象にする
function parseHighlightTerms(q: string): string[] {
  const terms: string[] = []
  const re = /"([^"]+)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(q))) {
    const term = m[1] ?? m[2]
    if (term) terms.push(term)
  }
  return terms
}

// 検索でヒットした部分をオレンジ色（既存のbotトークンを流用）でハイライト表示する
// （ユーザーからの要望）。ILIKEと同じ大文字小文字を区別しない一致で、excerpt・file_nameの
// 両方から使う。複数の検索語が重なってヒットする場合は範囲をマージして二重に囲まないようにする
function highlightTerms(text: string, terms: string[]): ReactNode {
  if (terms.length === 0) return text
  const lower = text.toLowerCase()
  const matches: { start: number; end: number }[] = []
  for (const term of terms) {
    const needle = term.toLowerCase()
    if (!needle) continue
    let idx = lower.indexOf(needle)
    while (idx !== -1) {
      matches.push({ start: idx, end: idx + needle.length })
      idx = lower.indexOf(needle, idx + needle.length)
    }
  }
  if (matches.length === 0) return text
  matches.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: { start: number; end: number }[] = []
  for (const m of matches) {
    const last = merged[merged.length - 1]
    if (last && m.start <= last.end) {
      last.end = Math.max(last.end, m.end)
    } else {
      merged.push({ ...m })
    }
  }
  const nodes: ReactNode[] = []
  let cursor = 0
  merged.forEach((m, i) => {
    if (m.start > cursor) nodes.push(text.slice(cursor, m.start))
    nodes.push(
      <mark key={i} className="rounded-[2px] bg-bot-bg px-0.5 font-semibold text-bot-text">
        {text.slice(m.start, m.end)}
      </mark>,
    )
    cursor = m.end
  })
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

// S-05 横断検索（F-06/F-07メッセージ・ファイル検索、F-42検索条件モディファイア、
// タブ切替UI・1タブ20件超の「もっと見る」を実装。ドキュメント根拠検索（層2）は
// 未実装のためタブは常時無効表示）
export default function SearchView() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { joined: channels } = useChannels()
  const navigate = useNavigate()

  const [input, setInput] = useState(() => composeInputText(searchParams))
  const [resolved, setResolved] = useState(() => composeResolved(searchParams))
  const [pickerType, setPickerType] = useState<ModifierType | null>(null)
  const [pickerQuery, setPickerQuery] = useState('')
  const [userResults, setUserResults] = useState<UserSearchResult[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (pickerType !== 'from' && pickerType !== 'with') {
      setUserResults([])
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch<{ items: UserSearchResult[] }>(`/api/users?q=${encodeURIComponent(pickerQuery)}`)
        if (!cancelled) setUserResults(res.items)
      } catch {
        // 検索失敗時は前回の候補を維持する（トーストは出さず静かに諦める。DmPickerModalと同じ方針）
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pickerType, pickerQuery])

  const candidates: Candidate[] =
    pickerType === 'in'
      ? channels
          .filter((c) => c.name.toLowerCase().includes(pickerQuery.toLowerCase()))
          .map((c) => ({ id: c.id, label: c.name }))
      : pickerType === 'from' || pickerType === 'with'
        ? userResults.map((u) => ({ id: u.id, label: u.name, sublabel: u.email }))
        : []
  const pickerOpen = pickerType !== null && candidates.length > 0

  const q = searchParams.get('q') ?? ''
  const hasQuery = !!(
    q || searchParams.get('in') || searchParams.get('from') || searchParams.get('with') ||
    searchParams.get('before') || searchParams.get('after') || searchParams.get('on') || searchParams.get('during')
  )
  const query = hasQuery
    ? {
        q,
        in: searchParams.get('in') ?? undefined,
        from: searchParams.get('from') ?? undefined,
        with: searchParams.get('with') ?? undefined,
        before: searchParams.get('before') ?? undefined,
        after: searchParams.get('after') ?? undefined,
        on: searchParams.get('on') ?? undefined,
        during: searchParams.get('during') ?? undefined,
      }
    : null
  const { result, isLoading } = useSearch(query)

  const activeChips: { type: ModifierType | DateModifierType; label: string }[] = []
  for (const type of ['in', 'from', 'with'] as ModifierType[]) {
    const v = searchParams.get(type)
    if (v) activeChips.push({ type, label: searchParams.get(`${type}_label`) ?? v })
  }
  for (const type of ['before', 'after', 'on', 'during'] as DateModifierType[]) {
    const v = searchParams.get(type)
    if (v) activeChips.push({ type, label: v })
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value
    setInput(text)
    const match = detectModifierQuery(text, e.target.selectionStart ?? text.length)
    setPickerType(match?.type ?? null)
    setPickerQuery(match?.query ?? '')
    setActiveIndex(0)
  }

  const selectCandidate = (candidate: Candidate) => {
    if (!pickerType) return
    const el = inputRef.current
    const cursor = el?.selectionStart ?? input.length
    const match = detectModifierQuery(input, cursor)
    if (!match) return
    const before = input.slice(0, match.tokenIndex)
    const after = input.slice(cursor)
    const insertText = `${pickerType}:${candidate.label} `
    setInput(before + insertText + after)
    setResolved((prev) => ({ ...prev, [pickerType]: { id: candidate.id, label: candidate.label } }))
    setPickerType(null)
    requestAnimationFrame(() => {
      const pos = before.length + insertText.length
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  const submit = () => {
    const built = buildQuery(input, resolved)
    const next = new URLSearchParams()
    if (built.q) next.set('q', built.q)
    for (const type of ['in', 'from', 'with'] as ModifierType[]) {
      const id = built[type]
      if (id) {
        next.set(type, id)
        const label = resolved[type]?.label
        if (label) next.set(`${type}_label`, label)
      }
    }
    for (const type of ['before', 'after', 'on', 'during'] as DateModifierType[]) {
      const v = built[type]
      if (v) next.set(type, v)
    }
    setSearchParams(next)
  }

  const removeChip = (type: ModifierType | DateModifierType) => {
    const next = new URLSearchParams(searchParams)
    next.delete(type)
    if (type === 'in' || type === 'from' || type === 'with') {
      next.delete(`${type}_label`)
      const label = resolved[type]?.label
      if (label) setInput((prev) => prev.replace(`${type}:${label}`, ' ').replace(/\s+/g, ' ').trim())
      setResolved((prev) => ({ ...prev, [type]: undefined }))
    } else {
      setInput((prev) => prev.replace(new RegExp(`${type}:\\S+`), ' ').replace(/\s+/g, ' ').trim())
    }
    setSearchParams(next)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (pickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % candidates.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectCandidate(candidates[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        setPickerType(null)
        return
      }
    }
    if (e.key === 'Enter') submit()
  }

  // 検索結果クリックでのハイライトジャンプ（ユーザーからの明示的な要望）。message_id（file結果は
  // 添付先の発言id）を?highlight=に付け、遷移先のMessageListがその発言までスクロールして
  // 薄いオレンジでフラッシュ表示する。スレッド返信（thread_parent_idあり）は本体タイムラインに
  // 流れないため、?thread=も付けてスレッドパネル側を開く（thread_parent_idが元発言のid）
  const openResult = (item: SearchResultItem) => {
    const params = new URLSearchParams()
    if (item.message_id) params.set('highlight', item.message_id)
    if (item.thread_parent_id) params.set('thread', item.thread_parent_id)
    const qs = params.toString() ? `?${params.toString()}` : ''
    if (item.channel_id) navigate(`/channels/${item.channel_id}${qs}`)
    else if (item.dm_id) navigate(`/dms/${item.dm_id}${qs}`)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-none px-7 pt-4">
        <div className="flex gap-2">
          <div className="relative w-full max-w-md">
            <div className="flex items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 py-2">
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="flex-none">
                <circle cx="9" cy="9" r="6.2" stroke="#8a8f98" strokeWidth="1.6" />
                <path d="M17 17l-3.6-3.6" stroke="#8a8f98" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              {/* placeholderはこの検索欄（max-w-md、実測クライアント幅約400px）に収まる長さに
                  留める。ユーザーからの報告で、元の文言「メッセージを検索（in:チャンネル
                  from:投稿者 のように条件を指定できます）」（実測描画幅約457px）が欄の幅を
                  超えて末尾が見切れ、読めなくなっていたことが判明した。placeholderは
                  ネイティブ<input>の仕様上折り返し・省略記号なしに切れるため、他の文言を
                  当てる際も同様に描画幅を確認すること */}
              <input
                ref={inputRef}
                value={input}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                placeholder="メッセージを検索（in:チャンネル from:投稿者）"
                className="w-full text-[13px] text-ink outline-none placeholder:text-ink-subtle"
                autoFocus
              />
            </div>

            {pickerOpen && pickerType && (
              <div className="absolute left-0 top-full z-40 mt-1.5 max-h-[280px] w-[320px] overflow-y-auto rounded-xl border border-line-strong bg-surface p-1.5 shadow-[0_12px_30px_rgba(16,24,40,0.18)]">
                <div className="px-2 pb-1 pt-1 text-[10.5px] font-bold text-ink-subtle">
                  {MODIFIER_LABEL[pickerType]}の候補（F-42）
                </div>
                {candidates.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      selectCandidate(c)
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${
                      i === activeIndex ? 'bg-surface-subtle' : 'hover:bg-surface-subtle'
                    }`}
                  >
                    <span
                      className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-bold text-white"
                      style={{ background: avatarColorFor(c.id) }}
                    >
                      {pickerType === 'in' ? '#' : c.label.slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-bold text-ink">
                        {pickerType === 'in' ? `# ${c.label}` : c.label}
                      </span>
                      {c.sublabel && <span className="block truncate text-[10.5px] text-ink-subtle">{c.sublabel}</span>}
                    </span>
                  </button>
                ))}
                <div className="border-t border-line px-2 pb-1 pt-1.5 text-[10.5px] leading-relaxed text-ink-subtle">
                  <code className="rounded bg-surface-muted px-1 text-accent-700">in:</code>チャンネル
                  <code className="rounded bg-surface-muted px-1 text-accent-700">from:</code>投稿者
                  <code className="rounded bg-surface-muted px-1 text-accent-700">with:</code>DM相手
                  <br />
                  <code className="rounded bg-surface-muted px-1 text-accent-700">before:</code>/
                  <code className="rounded bg-surface-muted px-1 text-accent-700">after:</code>/
                  <code className="rounded bg-surface-muted px-1 text-accent-700">on:</code>/
                  <code className="rounded bg-surface-muted px-1 text-accent-700">during:</code>日付
                  <code className="rounded bg-surface-muted px-1 text-accent-700">"…"</code>完全一致
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={submit}
            className="flex-none rounded-[7px] bg-accent-600 px-4 py-2 text-[13px] font-bold text-white"
          >
            検索
          </button>
        </div>

        {activeChips.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {activeChips.map((chip) => (
              <span
                key={chip.type}
                className="inline-flex items-center gap-1.5 rounded-full border border-accent-100 bg-accent-50 py-1 pl-2.5 pr-1.5 text-[11.5px] font-semibold text-accent-700"
              >
                {CHIP_LABEL[chip.type]}: {chip.type === 'in' ? `# ${chip.label}` : chip.label}
                <button
                  type="button"
                  onClick={() => removeChip(chip.type)}
                  className="flex h-[15px] w-[15px] flex-none items-center justify-center rounded-full bg-accent-100 text-[9px] text-accent-700"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        {hasQuery && result && (
          <h1 className="mt-4 text-[16px] text-ink">
            {q ? <span className="text-accent-700">「{q}」</span> : <span>検索結果</span>}
            <span className="ml-1.5 text-xs font-normal text-ink-subtle">
              {result.counts.message + result.counts.file}件
            </span>
          </h1>
        )}
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-accent-100 bg-accent-50 px-3 py-2.5 text-xs text-accent-700">
          <span>🔍</span>
          <span>
            検索対象は、あなたが参加しているチャンネル・DMの発言・添付ファイルに限定されます。
            <span className="mt-0.5 block text-[11px] text-ink-subtle">
              ドキュメント根拠の検索（Google Drive文書、層2）は未実装です。
            </span>
          </span>
        </div>
      </div>

      <div className="mt-2 flex-1 overflow-y-auto pb-6">
        {!hasQuery && <p className="px-7 pt-4 text-sm text-ink-subtle">検索語を入力してください。</p>}
        {hasQuery && isLoading && <p className="px-7 pt-4 text-sm text-ink-subtle">検索中...</p>}
        {hasQuery && result && query && (
          <SearchResultsTabs
            key={searchParams.toString()}
            result={result}
            query={query}
            onOpenResult={openResult}
          />
        )}
      </div>
    </div>
  )
}

type TabKey = 'all' | 'message' | 'file'
type PagedType = 'message' | 'file'

// タブ切替UI（F-06、詳細設計書API設計6.4節）。「初回検索でtype=allとして3種すべてを取得し、
// タブ切替のたびに再検索はしない」設計どおり、A-20は初回の1回だけ呼び、タブはresult.itemsを
// クライアント側でtypeによって絞り込むだけの表示切替にとどめる。1タブ最大20件を超える分は
// 「もっと見る」でtype・page指定の追加リクエストを行い、結果をextraItemsへ積み増す
// （6.4節「超過分は「もっと見る」でtype指定の追加リクエスト（type=message&page=2等）を行う」）。
// ドキュメント根拠タブは層2検索が未実装のため常に無効表示とする。keyにsearchParamsを使って
// 新しい検索のたびにマウントし直すことで、activeTab・もっと見るの状態を初期化する
// （useEffectでの同期を避ける、Reactの「keyで状態をリセットする」公式パターン）。
function SearchResultsTabs({
  result,
  query,
  onOpenResult,
}: {
  result: SearchResponse
  query: SearchQuery
  onOpenResult: (item: SearchResultItem) => void
}) {
  const toast = useToast()
  const [activeTab, setActiveTab] = useState<TabKey>('all')
  const [extraItems, setExtraItems] = useState<SearchResultItem[]>([])
  const [loadedPages, setLoadedPages] = useState<{ message: number; file: number }>({ message: 1, file: 1 })
  const [loadingMore, setLoadingMore] = useState<PagedType | null>(null)
  const highlightTermsList = parseHighlightTerms(query.q)

  const tabs: { key: TabKey; label: string; count: number }[] = [
    { key: 'all', label: 'すべて', count: result.counts.message + result.counts.file },
    { key: 'message', label: 'メッセージ', count: result.counts.message },
    { key: 'file', label: 'ファイル', count: result.counts.file },
  ]

  const allItems = [...result.items, ...extraItems]
  const messageItems = allItems.filter((item) => item.type === 'message')
  const fileItems = allItems.filter((item) => item.type === 'file')
  const hasMoreMessages = messageItems.length < result.counts.message
  const hasMoreFiles = fileItems.length < result.counts.file
  const visibleCount =
    activeTab === 'all' ? allItems.length : activeTab === 'message' ? messageItems.length : fileItems.length

  const loadMore = async (type: PagedType) => {
    setLoadingMore(type)
    try {
      const nextPage = loadedPages[type] + 1
      const params = searchParamsFor(query, { type, page: String(nextPage) })
      const res = await apiFetch<SearchResponse>(`/api/search?${params.toString()}`)
      setExtraItems((prev) => [...prev, ...res.items])
      setLoadedPages((prev) => ({ ...prev, [type]: nextPage }))
    } catch (e) {
      toast(e instanceof Error ? e.message : '読み込みに失敗しました', 'error')
    } finally {
      setLoadingMore(null)
    }
  }

  return (
    <>
      <div className="mx-7 flex items-center gap-1 border-b border-line">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`border-b-2 px-3 py-2 text-[13px] font-semibold ${
              activeTab === tab.key
                ? 'border-accent-600 text-accent-700'
                : 'border-transparent text-ink-subtle hover:text-ink-muted'
            }`}
          >
            {tab.label}
            <span className="ml-1 font-normal text-ink-subtle">{tab.count}</span>
          </button>
        ))}
        <span
          title="ドキュメント根拠検索（Google Drive文書、層2）は未実装です"
          className="cursor-not-allowed border-b-2 border-transparent px-3 py-2 text-[13px] font-semibold text-line-strong"
        >
          ドキュメント根拠
          <span className="ml-1 font-normal">未実装</span>
        </span>
      </div>

      {visibleCount === 0 && <p className="px-7 pt-4 text-sm text-ink-subtle">該当する結果がありません。</p>}

      {(activeTab === 'all' || activeTab === 'message') && messageItems.length > 0 && (
        <>
          {activeTab === 'all' && (
            <div className="mx-7 mt-3 text-[11px] font-bold tracking-wide text-ink-subtle">
              メッセージ（{result.counts.message}件）
            </div>
          )}
          {messageItems.map((item) => (
            <button
              key={item.message_id}
              type="button"
              onClick={() => onOpenResult(item)}
              className="flex w-full gap-3 border-b border-surface-muted px-7 py-2.5 text-left hover:bg-surface-subtle"
            >
              <div className="w-[150px] flex-none pt-px text-[11.5px] font-semibold text-ink">
                {item.channel_name ? `# ${item.channel_name}` : (item.dm_label ?? 'DM')}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-[7px]">
                  <Avatar message={avatarSourceFor(item)} size={18} />
                  <span className="text-[13px] font-bold text-ink">{item.sender_display_name ?? '(不明)'}</span>
                  <span className="text-[11px] text-ink-subtle">{formatDateTime(item.posted_at)}</span>
                </div>
                <div className="mt-0.5 text-[13px] leading-[1.7] text-ink">
                  {highlightTerms(item.excerpt ?? '', highlightTermsList)}
                </div>
              </div>
            </button>
          ))}
          {hasMoreMessages && (
            <div className="border-b border-surface-muted px-7 py-2.5">
              <button
                type="button"
                disabled={loadingMore === 'message'}
                onClick={() => loadMore('message')}
                className="rounded-md border border-line-strong px-3 py-1.5 text-[12px] font-semibold text-accent-700 hover:bg-accent-50 disabled:opacity-40"
              >
                {loadingMore === 'message' ? '読み込み中...' : `もっと見る（残り${result.counts.message - messageItems.length}件）`}
              </button>
            </div>
          )}
        </>
      )}

      {(activeTab === 'all' || activeTab === 'file') && fileItems.length > 0 && (
        <>
          {activeTab === 'all' && (
            <div className="mx-7 mt-3 text-[11px] font-bold tracking-wide text-ink-subtle">
              ファイル（{result.counts.file}件）
            </div>
          )}
          {fileItems.map((item) => (
            <div
              key={item.attachment_id}
              className="flex w-full items-center gap-3 border-b border-surface-muted px-7 py-2.5 hover:bg-surface-subtle"
            >
              <button
                type="button"
                onClick={() => onOpenResult(item)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <div className="w-[150px] flex-none text-[11.5px] font-semibold text-ink">
                  {item.channel_name ? `# ${item.channel_name}` : (item.dm_label ?? 'DM')}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-[7px]">
                    <span className="truncate text-[13px] font-bold text-ink">
                      📎 {highlightTerms(item.file_name ?? '', highlightTermsList)}
                    </span>
                    <span className="text-[11px] text-ink-subtle">
                      {item.byte_size !== undefined ? formatBytes(item.byte_size) : ''}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-ink-subtle">
                    <Avatar message={avatarSourceFor(item)} size={16} />
                    {item.sender_display_name ?? '(不明)'} ・ {formatDateTime(item.posted_at)}
                  </div>
                </div>
              </button>
              <a
                href={`/api/attachments/${item.attachment_id}`}
                className="flex-none rounded-md border border-line-strong px-2.5 py-1 text-[11.5px] font-semibold text-accent-700 hover:bg-accent-50"
              >
                ダウンロード
              </a>
            </div>
          ))}
          {hasMoreFiles && (
            <div className="px-7 py-2.5">
              <button
                type="button"
                disabled={loadingMore === 'file'}
                onClick={() => loadMore('file')}
                className="rounded-md border border-line-strong px-3 py-1.5 text-[12px] font-semibold text-accent-700 hover:bg-accent-50 disabled:opacity-40"
              >
                {loadingMore === 'file' ? '読み込み中...' : `もっと見る（残り${result.counts.file - fileItems.length}件）`}
              </button>
            </div>
          )}
        </>
      )}
    </>
  )
}
