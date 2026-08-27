import { apiFetch } from '../lib/api'
import { usePolling } from './usePolling'
import type { ScheduledMessagesResponse } from '../types'

// A-51: 自分が予約したメッセージ一覧（pendingのみ）。Layoutのヘッダーバッジと補足04モーダルで
// 共有する（05-3画面設計11.4節「更新の反映」）。予約が実際に送信されるとバッジ件数も自動的に
// 減るよう3秒間隔でポーリングする（他の未読バッジ等と同じ考え方）。
export function useScheduledMessages() {
  const { data, error, isLoading, mutate } = usePolling<ScheduledMessagesResponse>(
    '/api/scheduled-messages',
    apiFetch,
  )
  return { items: data?.items ?? [], error, isLoading, mutate }
}
