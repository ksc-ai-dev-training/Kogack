import useSWR from 'swr'
import { apiFetch, ApiError } from '../lib/api'
import type { Me } from '../types'

// A-04: ログイン中ユーザー。401（未ログイン）は null として扱う。
// 他の主要フック（usePolling経由）と同じrefreshIntervalを持たせる（ユーザーからの報告を受けて追加）。
// ログイン・ログアウトのボタンを経由しないセッション切り替え（複数タブ・別ブラウザでの再ログイン・
// dev-loginのAPI直接呼び出し等）は、フォーカス/オンライン復帰イベントだけに頼ると再検証の
// タイミングが不安定になりうる（実機検証で確認済み）。定期的な再検証を持たせることで、
// App.tsxのユーザー切り替えガードが確実に一定時間内（数秒）に働くようにする。
export function useMe() {
  const { data, error, isLoading, mutate } = useSWR<Me | null>(
    '/api/auth/me',
    async (url: string) => {
      try {
        return await apiFetch<Me>(url)
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null
        throw e
      }
    },
    { refreshInterval: 3000 },
  )
  return { me: data ?? null, error, isLoading, mutate }
}
