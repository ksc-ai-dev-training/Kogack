import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { AiSettings } from '../types'

// A-23: チャンネルAI設定一括取得（S-06「基本設定」「キャラクタ」「振る舞い定義」タブで使用）
export function useAiSettings(channelId: string | undefined) {
  const { data, error, isLoading, mutate } = useSWR<AiSettings>(
    channelId ? `/api/channels/${channelId}/ai-settings` : null,
    apiFetch,
  )
  return { settings: data ?? null, error, isLoading, mutate }
}
