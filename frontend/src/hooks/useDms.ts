import { apiFetch } from '../lib/api'
import { usePolling } from './usePolling'
import { desktopNotificationsEnabled } from './useDesktopNotifications'
import type { Dm, DmsResponse } from '../types'

// A-16: 参加中DM一覧。サイドバー・DM選択モーダル（既存DMタグ表示用）で共有。
// サイドバーの未読バッジ（unread_count）を他画面にいても追従させるため定期ポーリングする。
// デスクトップ通知を許可している利用者に限り、タブ非表示中もポーリングを継続する（useChannelsと同じ理由）。
export function useDms() {
  const { data, error, isLoading, mutate } = usePolling<DmsResponse>('/api/dms', apiFetch, {
    refreshWhenHidden: desktopNotificationsEnabled(),
  })
  return { dms: data?.items ?? ([] as Dm[]), error, isLoading, mutate }
}
