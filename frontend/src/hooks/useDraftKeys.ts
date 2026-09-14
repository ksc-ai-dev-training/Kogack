import { useEffect, useState } from 'react'
import { getDraftKeySet, subscribeDrafts } from '../lib/drafts'

// サイドバー（チャンネル/DM一覧）・MessageList（スレッド導線）が「このチャンネル/DM/スレッドに
// 下書きが残っているか」を判定するためのフック。下書きの本文そのものは持たず、キーの集合だけを
// 返す（lib/drafts.ts参照）。
export function useDraftKeys(): Set<string> {
  const [keys, setKeys] = useState(getDraftKeySet)
  useEffect(() => subscribeDrafts(() => setKeys(getDraftKeySet())), [])
  return keys
}
