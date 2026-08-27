import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { AdminUser, AdminUsersResponse } from '../types'

// A-36: 利用者一覧（S-08利用者管理タブ専用）
export function useAdminUsers() {
  const { data, error, isLoading, mutate } = useSWR<AdminUsersResponse>('/api/admin/users', apiFetch)
  return { users: data?.items ?? ([] as AdminUser[]), error, isLoading, mutate }
}
