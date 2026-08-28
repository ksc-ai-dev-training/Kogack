import { useState } from 'react'
import type { Message } from '../types'

// 会話を開いた瞬間の未読件数（A-05/A-16のunread_count、基本設計書4.2節）を1回だけ記録し、
// 「ここから未読」区切り線の位置として使う。開いている間に既読化ポーリングでunread_countが
// 0に戻っても、このセッション中は最初に記録した件数のまま区切り線の位置を固定する
// （Slack等の「新着メッセージ」区切り線と同じ考え方。新規API・DB変更は無く、既存の未読バッジの
// 値を流用するのみ）。conversationId切替時はReact公式の「レンダー中にstateを調整する」パターン
// （https://react.dev/reference/react/useState#storing-information-from-previous-renders）で
// 記録をリセットする。
export function useUnreadDivider(
  conversationId: string | undefined,
  unreadCountFromList: number | undefined,
  messages: Message[],
  meId: string | undefined,
): string | null {
  const [captured, setCaptured] = useState<{ conversationId: string; unread: number } | null>(null)

  if (conversationId && unreadCountFromList !== undefined && captured?.conversationId !== conversationId) {
    setCaptured({ conversationId, unread: unreadCountFromList })
  }

  if (!captured || captured.conversationId !== conversationId || captured.unread <= 0 || !meId) {
    return null
  }

  let remaining = captured.unread
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sender_user_id !== meId) {
      remaining--
      if (remaining === 0) return messages[i].id
    }
  }
  // 未読件数の分だけ遡っても読み込み済みメッセージ内に収まらない場合
  // （直近50件のみ初期読み込みするA-10/A-18の制約）、読み込み済みの先頭に区切り線を出す
  return remaining > 0 && messages.length > 0 ? messages[0].id : null
}
