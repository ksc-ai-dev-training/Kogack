import useSWR from 'swr'
import { apiFetch, ApiError } from '../lib/api'
import type { Me } from '../types'

// A-04: ログイン中ユーザー。401（未ログイン）は null として扱う
export function useMe() {
  const { data, error, isLoading, mutate } = useSWR<Me | null>('/api/auth/me', async (url: string) => {
    try {
      return await apiFetch<Me>(url)
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null
      throw e
    }
  })
  return { me: data ?? null, error, isLoading, mutate }
}
