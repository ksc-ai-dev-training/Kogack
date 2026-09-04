import { apiFetch } from '../lib/api'
import { usePolling } from './usePolling'
import type { ChannelMember, ChannelMembersResponse } from '../types'

// A-46: チャンネル参加者一覧（chadminバッジ・S-06チャンネル管理者タブの追加候補選定・
// メンション候補（Composer）で使用）。
// バグ修正（2026-09-04）: 従来は素のuseSWRで自動再取得の仕組みを持たず、チャンネルを開いた
// 最初の1回しか取得しなかった。そのため利用者が自分の表示名を変更しても、同じチャンネル
// 画面に留まる限りメンション候補（自分自身を含む）が古い名前のまま表示され続け、チャンネルを
// 切り替えて初めて（＝別のSWRキーへの新規fetchで）反映される、という不具合の報告を受けた。
// 他の一覧（チャンネル・DM・メッセージ）と同じusePolling（3秒間隔）に揃えて解消する
export function useChannelMembers(channelId: string | undefined) {
  const { data, error, isLoading, mutate } = usePolling<ChannelMembersResponse>(
    channelId ? `/api/channels/${channelId}/members` : null,
    apiFetch,
  )
  return { members: data?.items ?? ([] as ChannelMember[]), error, isLoading, mutate }
}
