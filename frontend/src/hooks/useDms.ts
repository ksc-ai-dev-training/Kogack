import { apiFetch } from '../lib/api'
import { usePolling } from './usePolling'
import type { Dm, DmsResponse } from '../types'

// A-16: 参加中DM一覧。サイドバー・DM選択モーダル（既存DMタグ表示用）で共有。
// サイドバーの未読バッジ（unread_count）を他画面にいても追従させるため3秒間隔でポーリングする。
export function useDms() {
  const { data, error, isLoading, mutate } = usePolling<DmsResponse>('/api/dms', apiFetch)
  return { dms: data?.items ?? ([] as Dm[]), error, isLoading, mutate }
}
