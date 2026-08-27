import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { SearchResponse } from '../types'

// A-20: 横断検索。ポーリングは不要（検索実行のたびに再取得する単発リクエスト）
export function useSearch(q: string) {
  const key = q.trim() ? `/api/search?q=${encodeURIComponent(q.trim())}` : null
  const { data, error, isLoading } = useSWR<SearchResponse>(key, apiFetch)
  return { result: data ?? null, error, isLoading }
}
