import { useRef } from 'react'
import { apiFetch } from '../lib/api'
import { usePolling } from './usePolling'
import type { Message, MessagesResponse } from '../types'

// A-10/A-18: メッセージ一覧。3秒間隔ポーリングでsince差分取得し、既存分に追記する
// （詳細設計書 総論9.1節・画面設計11.4節）。basePathはチャンネル・DM共通
// （例: /api/channels/42 や /api/dms/9）。切替時は履歴をリセットする。
// anchorMessageIdは検索結果からのハイライトジャンプ用（ユーザーからの明示的な要望）。指定時は
// 直近N件ではなく、その発言を中心に前後を取得する（around=、A-10/A-18）。取得後の継続ポーリングは
// 通常どおりsince差分に切り替わる（そこまでの間に投稿された分は追いつかず、以後の新着だけを
// 追いかける形になるが、検索結果は元々過去の文脈を見るためのものなのでこれで十分と判断）。
// anchorMessageIdがundefinedに変わった（呼び出し元がハイライト表示を終えて?highlight=を消した）
// だけでは状態をリセットしない＝それまでに読み込んだ内容は保持したまま、通常のsince継続ポーリングに
// 移行する。新しい（前回と異なる）anchorMessageIdが来たときだけ、その発言を中心に読み直す
export function useMessages(basePath: string | undefined, anchorMessageId?: string) {
  const state = useRef<{
    basePath: string
    anchor: string | null
    since: string | null
    messages: Message[]
  } | null>(null)

  // fetcherはSWRから渡されるkeyの文字列自体は使わない（下のusePollingのkeyはanchor変化時に
  // 即時再取得させるためのSWRキャッシュ識別子であり、実際にfetchするURLとは別物にしている。
  // 同じ内容をkeyにも組み込むと?around=が二重に付いてしまうため）。実際のURLは常にbasePathと
  // 内部stateから組み立てる
  const fetcher = async (): Promise<Message[]> => {
    const needsReset =
      !state.current ||
      state.current.basePath !== basePath ||
      (!!anchorMessageId && anchorMessageId !== state.current.anchor)
    if (needsReset) {
      state.current = { basePath: basePath!, anchor: anchorMessageId ?? null, since: null, messages: [] }
    }
    const s = state.current!
    const url = s.since
      ? `${basePath}/messages?since=${encodeURIComponent(s.since)}`
      : s.anchor
        ? `${basePath}/messages?around=${encodeURIComponent(s.anchor)}`
        : `${basePath}/messages`
    const res = await apiFetch<MessagesResponse>(url)
    if (res.items.length > 0) {
      s.messages = s.since ? [...s.messages, ...res.items] : res.items
      s.since = res.items[res.items.length - 1].created_at
    }
    return s.messages
  }

  const { data, error, isLoading, mutate } = usePolling<Message[]>(
    basePath ? `${basePath}/messages${anchorMessageId ? `::around=${anchorMessageId}` : ''}` : null,
    fetcher,
  )

  // sinceによる差分ポーリングは新着行しか取り込まないため、返信投稿時に元発言のthread_reply_countが
  // 更新されない（次のポーリングでも対象外のまま）。ThreadPanelでの返信直後にその場で反映するための
  // 楽観的更新（チャンネル切替でstate.currentがリセットされるまで直らない、という体験上の遅延を解消する）
  const bumpThreadReplyCount = (messageId: string) => {
    if (!state.current) return
    state.current.messages = state.current.messages.map((m) =>
      m.id === messageId ? { ...m, thread_reply_count: (m.thread_reply_count ?? 0) + 1 } : m,
    )
    mutate(state.current.messages, { revalidate: false })
  }

  // A-12削除も同じ理由（sinceポーリングは既存キャッシュ行の消失を検知できない）で
  // その場で一覧から取り除く楽観的更新が必要
  const removeMessage = (messageId: string) => {
    if (!state.current) return
    state.current.messages = state.current.messages.filter((m) => m.id !== messageId)
    mutate(state.current.messages, { revalidate: false })
  }

  // スレッド内で返信を削除したときも、元発言のthread_reply_countをその場で反映する
  const decrementThreadReplyCount = (messageId: string) => {
    if (!state.current) return
    state.current.messages = state.current.messages.map((m) =>
      m.id === messageId ? { ...m, thread_reply_count: Math.max((m.thread_reply_count ?? 1) - 1, 0) } : m,
    )
    mutate(state.current.messages, { revalidate: false })
  }

  return {
    messages: data ?? [], error, isLoading, mutate,
    bumpThreadReplyCount, removeMessage, decrementThreadReplyCount,
  }
}
