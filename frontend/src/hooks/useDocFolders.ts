import { usePolling } from './usePolling'
import { apiFetch } from '../lib/api'
import type { DocFolder, DocFoldersResponse } from '../types'

// A-38: 参照ドキュメントフォルダ候補の一覧（S-08「ドキュメント参照範囲」タブ・S-06参照範囲選択で共用）。
// 3秒間隔ポーリングにしたのは、アップロード後の索引化（Slice 3、2026-09-09）が非同期のバックグラウンド
// タスクのため、pending→indexing→ready/failedという状態変化を画面のリロード無しで追従させるため
// （従来は素のuseSWRで、useChannelMembers等と同じ「初回取得のみで自動更新されない」不具合を
// 抱えていたが、この機能追加を機に解消した）。
export function useDocFolders() {
  const { data, error, isLoading, mutate } = usePolling<DocFoldersResponse>('/api/admin/doc-folders', apiFetch)
  return { folders: data?.items ?? ([] as DocFolder[]), error, isLoading, mutate }
}
