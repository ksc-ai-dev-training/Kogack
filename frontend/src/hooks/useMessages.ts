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
      if (s.since) {
        // バグ修正（2026-09-04）: sinceでの差分取得は「新規行」だけでなく「既存行の更新」
        // （AI応答が生成中→本文確定になる等、UPDATEのみでcreated_atが変わらないケース）も
        // 返ってきうる（バックエンド側もsinceの絞り込みをupdated_at基準に変更済み）。従来は
        // 常に末尾へ追記するだけだったため、一度「生成中」の状態でこの行を取得すると、
        // 画面を切り替えない限り本文確定後の内容が永久に反映されないバグがあった。
        // id一致で上書きすることで、既存行はその場で内容が更新され、新規行だけが追記される
        const byId = new Map(s.messages.map((m) => [m.id, m] as const))
        for (const item of res.items) byId.set(item.id, item)
        s.messages = [...byId.values()]
      } else {
        s.messages = res.items
      }
      s.since = res.items[res.items.length - 1].updated_at
    }
    return s.messages
  }

  // メッセージ一覧のみポーリング間隔を短縮する試験的な変更（ユーザーからの要望、2026-09-04）。
  // 基本設計書2.2節・8.7節の「3秒間隔」という全体方針は変えず、usePollingの既定値（usePolling.ts）は
  // そのまま3000msに残し、ここだけ個別にconfigで上書きする。サイドバー・未読バッジ・スレッド等は
  // 従来どおり3秒のまま（影響範囲を会話ログの表示に限定するため）。使用感を試したうえで本採用するか
  // 判断する想定で、CLAUDE.mdへの記録は結論が出てから行う
  //
  // dedupingIntervalもrefreshIntervalと同じ1000msに揃える必要がある。SWRの既定は2000msで、
  // 同一キーへのリクエストをその間隔内は重複とみなして間引く仕様のため、refreshIntervalだけ
  // 1000msにしてもここを2000msのままにすると実質的に2秒に1回しか新規リクエストが飛ばない
  // （同じ画面に居続けるより、別のチャンネル/DMへ切替→復帰した方が速く反映される、という
  // ユーザー報告のとおりの症状になる。切替先は別のSWRキーのため間引きの対象外になるため）
  const { data, error, isLoading, mutate } = usePolling<Message[]>(
    basePath ? `${basePath}/messages${anchorMessageId ? `::around=${anchorMessageId}` : ''}` : null,
    fetcher,
    { refreshInterval: 1000, dedupingInterval: 1000 },
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
