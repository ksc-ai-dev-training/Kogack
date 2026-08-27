import { useRef } from 'react'
import { apiFetch } from '../lib/api'
import { usePolling } from './usePolling'
import type { Message, MessagesResponse } from '../types'

// A-10/A-18: メッセージ一覧。3秒間隔ポーリングでsince差分取得し、既存分に追記する
// （詳細設計書 総論9.1節・画面設計11.4節）。basePathはチャンネル・DM共通
// （例: /api/channels/42 や /api/dms/9）。切替時は履歴をリセットする。
export function useMessages(basePath: string | undefined) {
  const state = useRef<{ basePath: string; since: string | null; messages: Message[] } | null>(null)

  const fetcher = async (path: string): Promise<Message[]> => {
    if (!state.current || state.current.basePath !== basePath) {
      state.current = { basePath: basePath!, since: null, messages: [] }
    }
    const s = state.current
    const url = s.since ? `${path}?since=${encodeURIComponent(s.since)}` : path
    const res = await apiFetch<MessagesResponse>(url)
    if (res.items.length > 0) {
      s.messages = s.since ? [...s.messages, ...res.items] : res.items
      s.since = res.items[res.items.length - 1].created_at
    }
    return s.messages
  }

  const { data, error, isLoading, mutate } = usePolling<Message[]>(
    basePath ? `${basePath}/messages` : null,
    fetcher,
  )

  // sinceによる差分ポーリングは新着行しか取り込まないため、返信投稿時に元発言のthread_reply_countが
  // 更新されない（次のポーリングでも対象外のまま）。ThreadPanelでの返信直後にその場で反映するための
  // 楽観的更新（チャンネル切替でstate.currentがリセットされるまで直らない、という体験上の遅延を解消する）
  const bumpThreadReplyCount = (messageId: string) => {
    if (!state.current) return
    state.current.messages = state.current.messages.map((m) =>
      m.id === messageId ? { ...m, thread_reply_count: (m.thread_reply_count ?? 0) + 1 } : m,
    )
    mutate(state.current.messages, { revalidate: false })
  }

  // A-12削除も同じ理由（sinceポーリングは既存キャッシュ行の消失を検知できない）で
  // その場で一覧から取り除く楽観的更新が必要
  const removeMessage = (messageId: string) => {
    if (!state.current) return
    state.current.messages = state.current.messages.filter((m) => m.id !== messageId)
    mutate(state.current.messages, { revalidate: false })
  }

  // スレッド内で返信を削除したときも、元発言のthread_reply_countをその場で反映する
  const decrementThreadReplyCount = (messageId: string) => {
    if (!state.current) return
    state.current.messages = state.current.messages.map((m) =>
      m.id === messageId ? { ...m, thread_reply_count: Math.max((m.thread_reply_count ?? 1) - 1, 0) } : m,
    )
    mutate(state.current.messages, { revalidate: false })
  }

  return {
    messages: data ?? [], error, isLoading, mutate,
    bumpThreadReplyCount, removeMessage, decrementThreadReplyCount,
  }
}
