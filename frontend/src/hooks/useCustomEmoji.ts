import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { CustomEmoji, CustomEmojiResponse } from '../types'

// カスタム絵文字一覧（ユーザーからの明示的な要望「Slackみたいにリアクションスタンプ（絵文字）を
// 自分で作成できる機能が欲しい」、2026-09-17）。チャンネル・DM一覧のような常時変化する情報とは
// 異なり、新しい絵文字の追加は低頻度なため、usePolling（常時5秒間隔で背景ポーリングし続ける）は
// 使わず、useAdminUsers等と同じ素のuseSWR（マウント時・フォーカス復帰時のみ再検証）にした
// （2026-09-10にユーザーから受けた「ポーリング負荷が気になる」という指摘を踏まえ、変化が
// 稀なリストにまで常時ポーリングを広げない判断）。自分が新規作成した直後はmutate()で
// 即座に反映させる。
export function useCustomEmoji() {
  const { data, error, isLoading, mutate } = useSWR<CustomEmojiResponse>('/api/custom-emoji', apiFetch)
  return { customEmoji: data?.items ?? ([] as CustomEmoji[]), error, isLoading, mutate }
}
