import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { AuditLogsResponse } from '../types'

export interface AuditLogFilters {
  event_type?: string
  actor_user_id?: string
  after?: string
  before?: string
}

// A-44: 監査ログ一覧（S-08「監査ログ」タブ専用）。種別・実行者・期間で絞り込む。
export function useAuditLogs(filters: AuditLogFilters) {
  const params = new URLSearchParams()
  if (filters.event_type) params.set('event_type', filters.event_type)
  if (filters.actor_user_id) params.set('actor_user_id', filters.actor_user_id)
  if (filters.after) params.set('after', filters.after)
  if (filters.before) params.set('before', filters.before)
  const { data, error, isLoading } = useSWR<AuditLogsResponse>(
    `/api/admin/audit-logs?${params.toString()}`,
    apiFetch,
  )
  return { logs: data?.items ?? [], hasMore: data?.has_more ?? false, error, isLoading }
}
