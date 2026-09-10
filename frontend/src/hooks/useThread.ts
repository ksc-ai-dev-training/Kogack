import { useRef } from 'react'
import { apiFetch } from '../lib/api'
import { usePolling } from './usePolling'
import type { Message, MessagesResponse } from '../types'

// A-13: スレッド内の返信一覧。3秒間隔ポーリング（総論9.1節・画面設計11.4節）。
// 履歴が短いため差分取得はせず、毎回全件を取り直す（useMessagesのsince方式とは異なる）。
export function useThread(messageId: string | null) {
  // 直近の取得結果を保持する（useMessages.tsのstate.currentと同じ考え方）。単純に毎回
  // res.itemsへ丸ごと置き換えるのではなく、updated_atを比較してマージすることで、
  // リアクショントグル（updateReplyReactions、下記）のような楽観的更新がこの関数の
  // await中に割り込んだ場合でも、後から解決した古いポーリングレスポンスに巻き戻されない
  // ようにする（2026-09-10、絵文字リアクション機能の実機検証でuseMessages.ts側に見つかった
  // のと同じ種類の競合をここにも見つけたため、同じ考え方で対処した）
  const state = useRef<{ threadId: string; items: Message[] } | null>(null)

  const fetcher = async (url: string): Promise<MessagesResponse> => {
    const needsReset = !state.current || state.current.threadId !== messageId
    if (needsReset) state.current = { threadId: messageId!, items: [] }
    const s = state.current!
    const res = await apiFetch<MessagesResponse>(url)
    const byId = new Map(s.items.map((m) => [m.id, m] as const))
    for (const item of res.items) {
      const existing = byId.get(item.id)
      if (existing && new Date(existing.updated_at).getTime() > new Date(item.updated_at).getTime()) continue
      byId.set(item.id, item)
    }
    // このレスポンスに実在するidの集合を正として、削除された返信（レスポンスから消えた行）は
    // ここで取り除く（byIdへのマージだけだと削除が反映されず残り続けてしまうため）
    const responseIds = new Set(res.items.map((m) => m.id))
    const merged = [...byId.values()].filter((m) => responseIds.has(m.id))
    merged.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    s.items = merged
    return { items: merged, has_more: res.has_more }
  }

  const { data, error, isLoading, mutate } = usePolling<MessagesResponse>(
    messageId ? `/api/messages/${messageId}/thread` : null,
    fetcher,
  )

  // 絵文字リアクション（A-75）のその場反映（useMessages.updateMessageReactionsと同じ考え方）。
  // ThreadPanel.tsxの元発言ヘッダーはMessageListを経由しないため対象外（そちらは3秒ポーリングで
  // 自然に追いつくのを待つ設計のまま）だが、返信一覧（MessageList経由）はここで即時反映する
  const updateReplyReactions = (targetMessageId: string, reactions: Message['reactions']) => {
    if (!state.current) return
    state.current.items = state.current.items.map((m) =>
      m.id === targetMessageId ? { ...m, reactions } : m,
    )
    mutate({ items: state.current.items, has_more: false }, { revalidate: false })
  }

  return { replies: data?.items ?? ([] as Message[]), error, isLoading, mutate, updateReplyReactions }
}
