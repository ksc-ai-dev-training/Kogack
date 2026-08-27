import { apiFetch } from '../lib/api'
import { usePolling } from './usePolling'
import type { Message, MessagesResponse } from '../types'

// A-13: スレッド内の返信一覧。3秒間隔ポーリング（総論9.1節・画面設計11.4節）。
// 履歴が短いため差分取得はせず、毎回全件を取り直す（useMessagesのsince方式とは異なる）。
export function useThread(messageId: string | null) {
  const { data, error, isLoading, mutate } = usePolling<MessagesResponse>(
    messageId ? `/api/messages/${messageId}/thread` : null,
    apiFetch,
  )
  return { replies: data?.items ?? ([] as Message[]), error, isLoading, mutate }
}
