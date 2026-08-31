import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { UsageStats } from '../types'

// A-42: AI利用状況・概算コストの月次集計（S-08「AI利用状況・コスト」タブ専用）。
// monthを省略するとサーバー側でJSTの当月を対象にする。
export function useUsageStats(month: string) {
  const { data, error, isLoading, mutate } = useSWR<UsageStats>(
    `/api/admin/usage?month=${encodeURIComponent(month)}`,
    apiFetch,
  )
  return { usage: data ?? null, error, isLoading, mutate }
}
