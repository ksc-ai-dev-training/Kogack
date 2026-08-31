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

// A-20: 横断検索。ポーリングは不要（検索実行のたびに再取得する単発リクエスト）。
// F-42のin:/from:/with:/before:/after:/on:/duringモディファイアはid・日付文字列の形でそのまま
// クエリパラメータへ渡す（バックエンド側の解決・パースはrouters/search.pyが担う）
export function useSearch(query: SearchQuery | null) {
  const hasAnyCondition =
    !!query &&
    !!(query.q || query.in || query.from || query.with || query.before || query.after || query.on || query.during)
  const key = hasAnyCondition && query
    ? (() => {
        const params = new URLSearchParams()
        if (query.q) params.set('q', query.q)
        for (const k of ['in', 'from', 'with', 'before', 'after', 'on', 'during'] as const) {
          const v = query[k]
          if (v) params.set(k, v)
        }
        return `/api/search?${params.toString()}`
      })()
    : null
  const { data, error, isLoading } = useSWR<SearchResponse>(key, apiFetch)
  return { result: data ?? null, error, isLoading }
}
