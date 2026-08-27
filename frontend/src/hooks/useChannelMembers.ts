import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { ChannelMember, ChannelMembersResponse } from '../types'

// A-46: チャンネル参加者一覧（chadminバッジ・S-06チャンネル管理者タブの追加候補選定で使用）
export function useChannelMembers(channelId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<ChannelMembersResponse>(
    channelId ? `/api/channels/${channelId}/members` : null,
    apiFetch,
  )
  return { members: data?.items ?? ([] as ChannelMember[]), error, isLoading, mutate }
}
