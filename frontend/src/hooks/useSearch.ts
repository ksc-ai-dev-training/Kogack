import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { SearchResponse } from '../types'

export interface SearchQuery {
  q: string
  in?: string
  from?: string
  with?: string
  before?: string
  after?: string
  on?: string
  during?: string
}

// SearchQueryをA-20のクエリパラメータへ変換する（useSearch本体と、S-05「もっと見る」の
// type/page付き追加リクエストの両方から共有する）
export function searchParamsFor(query: SearchQuery, extra?: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams()
  if (query.q) params.set('q', query.q)
  for (const k of ['in', 'from', 'with', 'before', 'after', 'on', 'during'] as const) {
    const v = query[k]
    if (v) params.set(k, v)
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) params.set(k, v)
  }
  return params
}

// A-20: 横断検索。ポーリングは不要（検索実行のたびに再取得する単発リクエスト）。
// F-42のin:/from:/with:/before:/after:/on:/duringモディファイアはid・日付文字列の形でそのまま
// クエリパラメータへ渡す（バックエンド側の解決・パースはrouters/search.pyが担う）
export function useSearch(query: SearchQuery | null) {
  const hasAnyCondition =
    !!query &&
    !!(query.q || query.in || query.from || query.with || query.before || query.after || query.on || query.during)
  const key = hasAnyCondition && query ? `/api/search?${searchParamsFor(query).toString()}` : null
  const { data, error, isLoading } = useSWR<SearchResponse>(key, apiFetch)
  return { result: data ?? null, error, isLoading }
}
