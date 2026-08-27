import useSWR, { type SWRConfiguration } from 'swr'

// 3秒間隔ポーリング共通hook（詳細設計書 総論2.1節・画面設計11.1節・11.4節）。
// useSWRのrefreshIntervalの薄いラッパーで、メッセージ一覧等のリアルタイム表示に使う。
export function usePolling<T>(key: string | null, fetcher: (key: string) => Promise<T>, config?: SWRConfiguration) {
  return useSWR<T>(key, fetcher, { refreshInterval: 3000, revalidateOnFocus: true, ...config })
}
