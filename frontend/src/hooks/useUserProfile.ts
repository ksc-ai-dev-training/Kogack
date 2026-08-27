import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { UserProfile } from '../types'

// A-67: プロフィールカード（F-40）専用。表示するメッセージ作者ごとに個別のキーで呼ばれる
export function useUserProfile(userId: string | undefined) {
  const { data, error, isLoading } = useSWR<UserProfile>(
    userId ? `/api/users/${userId}` : null,
    apiFetch,
  )
  return { profile: data ?? null, error, isLoading }
}
