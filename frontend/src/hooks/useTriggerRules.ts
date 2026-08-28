import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { TriggerRule, TriggerRulesResponse } from '../types'

// A-63: このチャンネルの自動応答トリガー一覧（S-06「自動応答トリガー」タブ）
export function useTriggerRules(channelId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<TriggerRulesResponse>(
    channelId ? `/api/channels/${channelId}/trigger-rules` : null,
    apiFetch,
  )
  return { items: data?.items ?? ([] as TriggerRule[]), error, isLoading, mutate }
}
