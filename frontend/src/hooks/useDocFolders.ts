import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import type { DocFolder, DocFoldersResponse } from '../types'

// A-38: 参照ドキュメントフォルダ候補の一覧（S-08「ドキュメント参照範囲」タブ専用）
export function useDocFolders() {
  const { data, error, isLoading, mutate } = useSWR<DocFoldersResponse>('/api/admin/doc-folders', apiFetch)
  return { folders: data?.items ?? ([] as DocFolder[]), error, isLoading, mutate }
}
