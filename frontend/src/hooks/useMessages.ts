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
        // id一致で上書きすることで、既存行はその場で内容が更新され、新規行だけが追記される。
        //
        // バグ修正（2026-09-10、絵文字リアクション機能の実機検証で発見）: この関数は非同期
        // （await apiFetch中に他の処理が進む）ため、リアクショントグル（updateMessageReactions）
        // のような楽観的更新がこの関数の実行中（awaitで待っている間）に割り込むことがある。
        // 従来は無条件にres.items（このリクエスト自身が発行された時点でのサーバーの状態、
        // つまり楽観的更新より古いスナップショットのことがある）で上書きしていたため、
        // 「リアクションを追加した直後にもう一つ追加すると、ほぼ同時に飛んでいた古いポーリング
        // レスポンスが後から解決してその場での反映を巻き戻してしまう」という不具合が実機検証で
        // 再現した。updated_atを比較し、既にローカルの方が新しい（＝この行はこのポーリング
        // リクエストが発行された後に別の更新があった）場合はそちらを優先し、古いレスポンスでの
        // 上書きをスキップする
        const byId = new Map(s.messages.map((m) => [m.id, m] as const))
        for (const item of res.items) {
          const existing = byId.get(item.id)
          if (existing && new Date(existing.updated_at).getTime() > new Date(item.updated_at).getTime()) continue
          byId.set(item.id, item)
        }
        s.messages = [...byId.values()]
      } else {
        s.messages = res.items
      }
      // バグ修正（2026-09-04）: 定期投稿・送信予約はcreated_atを本来の予定時刻にさかのぼらせる
      // ことがある（アプリの長時間停止からの復帰時に欠落回をまとめて追いつかせて送信する際、
      // 実際のディスパッチ時刻ではなく予約時刻どおりに見せるため。scheduled_dispatcher.py参照）。
      // sinceでの差分取得はid一致で上書き・新規行は末尾に追記するだけなので、そのままだと
      // 過去の日時を持つ発言が画面の一番下に挿入されてしまう。created_at昇順に並べ替えることで、
      // 実際の会話の流れに沿った位置に表示する
      s.messages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
      s.since = res.items[res.items.length - 1].updated_at
    }
    return s.messages
  }

  // メッセージ一覧のみポーリング間隔を他より短縮する（2026-09-04にユーザーの要望で1000msへ
  // 短縮・本採用したが、2026-09-10にユーザー経由で共有された「100人規模で使うとポーリングの
  // 負荷が気になる」という指摘を受け、2000msへ緩和した。体感速度への影響を抑えるため元の
  // 3000msへ完全に戻すのではなく、間に取る形にした。基本設計書2.2節・8.7節の「3秒間隔」という
  // 全体方針自体は変えず、usePollingの既定値（usePolling.ts、こちらも同じ理由で5000msへ緩和済み）
  // より短い値だけをここで個別にconfigで上書きする、という構造自体は従来どおり）
  //
  // dedupingIntervalもrefreshIntervalと同じ値に揃える必要がある。SWRの既定は2000msで、
  // 同一キーへのリクエストをその間隔内は重複とみなして間引く仕様のため、refreshIntervalだけ
  // 短くしてもdedupingIntervalの方が長いままだと実質的にそちらの間隔でしか新規リクエストが
  // 飛ばない（同じ画面に居続けるより、別のチャンネル/DMへ切替→復帰した方が速く反映される、
  // という2026-09-04当時のユーザー報告のとおりの症状になる。切替先は別のSWRキーのため
  // 間引きの対象外になるため）
  const { data, error, isLoading, mutate } = usePolling<Message[]>(
    basePath ? `${basePath}/messages${anchorMessageId ? `::around=${anchorMessageId}` : ''}` : null,
    fetcher,
    { refreshInterval: 2000, dedupingInterval: 2000 },
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

  // 絵文字リアクション（A-75）も同じ理由の楽観的更新。トグルAPIのレスポンスに含まれる
  // 更新後のreactions一覧をそのまま反映する（推測で組み立てるのではなく、サーバーが実際に
  // 確定した値を使う。3秒ポーリングを待たず自分の操作をその場で反映させるため）
  const updateMessageReactions = (messageId: string, reactions: Message['reactions']) => {
    if (!state.current) return
    state.current.messages = state.current.messages.map((m) =>
      m.id === messageId ? { ...m, reactions } : m,
    )
    mutate(state.current.messages, { revalidate: false })
  }

  // 発言の編集（ユーザーからの明示的な要望）も同じ理由の楽観的更新。編集APIのレスポンスに
  // 含まれる更新後の発言（body・is_edited・updated_at）をそのまま反映する
  // （updateMessageReactionsと同じ「サーバーが実際に確定した値を使う」考え方）
  const updateMessage = (updated: Message) => {
    if (!state.current) return
    state.current.messages = state.current.messages.map((m) => (m.id === updated.id ? updated : m))
    mutate(state.current.messages, { revalidate: false })
  }

  return {
    messages: data ?? [], error, isLoading, mutate,
    bumpThreadReplyCount, removeMessage, decrementThreadReplyCount, updateMessageReactions, updateMessage,
  }
}
