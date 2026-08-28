import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { RecurringPost, RecurringPostsResponse } from '../types'

// A-53: このチャンネルの定期投稿ルール一覧（S-06「定期投稿」タブ）
export function useRecurringPosts(channelId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<RecurringPostsResponse>(
    channelId ? `/api/channels/${channelId}/recurring-posts` : null,
    apiFetch,
  )
  return { items: data?.items ?? ([] as RecurringPost[]), error, isLoading, mutate }
}
