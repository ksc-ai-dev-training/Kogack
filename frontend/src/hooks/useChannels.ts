import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import { usePolling } from './usePolling'
import { desktopNotificationsEnabled } from './useDesktopNotifications'
import type { Channel, ChannelDetail, ChannelsResponse } from '../types'

// A-05: 参加中チャンネル一覧＋参加可能な公開チャンネル一覧。サイドバー・チャンネル作成/参加モーダルで共有。
// サイドバーの未読バッジ（unread_count）を他画面にいても追従させるため定期ポーリングする。
// デスクトップ通知（useDesktopNotifications）を許可している利用者に限り、タブ非表示中も
// ポーリングを継続する（そうしないと非表示時に新着を検知できず通知が出せない）。
export function useChannels() {
  const { data, error, isLoading, mutate } = usePolling<ChannelsResponse>('/api/channels', apiFetch, {
    refreshWhenHidden: desktopNotificationsEnabled(),
  })
  return {
    joined: data?.joined ?? ([] as Channel[]),
    joinable: data?.joinable ?? ([] as Channel[]),
    error,
    isLoading,
    mutate,
  }
}

// A-06: チャンネル詳細。channelId未定時はキーnullで取得しない
export function useChannel(channelId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<ChannelDetail>(
    channelId ? `/api/channels/${channelId}` : null,
    apiFetch,
  )
  return { channel: data ?? null, error, isLoading, mutate }
}
