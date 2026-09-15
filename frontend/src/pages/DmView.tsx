import { useEffect, useLayoutEffect, useRef } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useDms } from '../hooks/useDms'
import { useMessages } from '../hooks/useMessages'
import { useUnreadDivider } from '../hooks/useUnreadDivider'
import { useMe } from '../hooks/useMe'
import { apiFetch } from '../lib/api'
import MessageList from '../components/MessageList'
import Composer from '../components/Composer'
import ThreadPanel from '../components/ThreadPanel'
import NotifModeButton from '../components/NotifModeButton'
import HeaderSearchBar from '../components/HeaderSearchBar'
import type { AttachmentPayload, ChannelNotifMode, MentionPayload } from '../types'

// S-03相当のDM会話＋S-04スレッド表示（ChannelViewのDM版）。ヘッダーはチャンネル名の代わりに相手の氏名を表示する。
// 参加者は開始時に固定のため、詳細取得API（A-06相当）は無くA-16の一覧から該当DMを引く。
// 自分専用DM（F-05、dm.is_self）はタイトルを「自分（メモ）」固定表記にする（自分の氏名をそのまま
// 出すと紛らわしいため）。それ以外の挙動（投稿・スレッド・既読化等）は通常のDMと完全に共通
export default function DmView() {
  const { dmId } = useParams<{ dmId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const threadId = searchParams.get('thread')
  // S-05横断検索の結果クリックでのハイライトジャンプ先（ChannelViewと同じ考え方。
  // ユーザーからの明示的な要望）
  const highlightId = searchParams.get('highlight')
  const { me } = useMe()
  const { dms, isLoading: dmsLoading, mutate: mutateDms } = useDms()
  const dm = dms.find((d) => d.id === dmId)
  // F-41 メンション候補（バグ修正2026-09-04でDMも対応。ユーザーからの明示的な要望）。
  // ChannelViewのmentionCandidatesWithAiと同じ考え方だが、DMにはチャンネルAIが存在しないため
  // isAi合成候補は追加せず、このDMのメンバー（自分以外、無効化アカウントを除く）のみを候補にする
  const mentionCandidates = dm?.members.filter((m) => m.is_active) ?? []
  const anchorMessageId = highlightId ? (threadId ?? highlightId) : undefined
  const {
    messages, mutate: mutateMessages, bumpThreadReplyCount, removeMessage, decrementThreadReplyCount,
    updateMessageReactions, updateMessage, hasOlder, loadingOlder, loadOlder,
  } = useMessages(dmId ? `/api/dms/${dmId}` : undefined, anchorMessageId)
  const unreadDividerMessageId = useUnreadDivider(dmId, dm?.unread_count, messages, me?.id)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // ChannelViewと同じ理由でハイライトジャンプ中は末尾自動スクロールを止める
    if (highlightId && !threadId) return
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
    // バグ修正（2026-09-11）: ChannelView.tsxと同じ不具合・同じ対処
    // （AI応答本文が「生成中…」から実際の長い回答へ更新される際、messages.lengthが変化しないため
    // 従来はスクロール位置が据え置かれ、長い回答の1行目しか見えなかった）。
    // バグ修正（2026-09-15、ChannelView.tsxと同じ不具合・同じ対処）: 「もっと古いメッセージを
    // 読み込む」（loadOlder）を追加したため依存配列からmessages.lengthを外した（理由は
    // ChannelView.tsxの同じコメント参照。古い発言を先頭に追加してもmessages.lengthは変わるが
    // 最後のメッセージのupdated_atは変わらないため、lengthを残しているとさかのぼるたびに
    // 末尾へ引き戻されてしまう）
  }, [messages[messages.length - 1]?.updated_at, highlightId, threadId])

  // 「もっと古いメッセージを読み込む」（ユーザーからの明示的な要望、2026-09-15）。
  // ChannelView.tsxと全く同じ考え方・同じスクロール位置保持の仕組み（詳細はそちらのコメント参照）
  const pendingScrollAdjustRef = useRef<number | null>(null)
  const handleLoadOlder = async () => {
    if (listRef.current) pendingScrollAdjustRef.current = listRef.current.scrollHeight
    await loadOlder()
  }
  useLayoutEffect(() => {
    if (pendingScrollAdjustRef.current === null || !listRef.current) return
    const prevScrollHeight = pendingScrollAdjustRef.current
    pendingScrollAdjustRef.current = null
    listRef.current.scrollTop += listRef.current.scrollHeight - prevScrollHeight
  }, [messages])

  useEffect(() => {
    // ChannelViewと同じ、ハイライト表示の一時的な?highlight=クリア
    if (!highlightId) return
    const t = setTimeout(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete('highlight')
        return next
      }, { replace: true })
    }, 3000)
    return () => clearTimeout(t)
  }, [highlightId, setSearchParams])

  useEffect(() => {
    // このDMを開いている間は既読として扱う（未読バッジ用。ChannelViewと同じ考え方）
    if (!dmId) return
    apiFetch(`/api/dms/${dmId}/read`, { method: 'POST' })
      .then(() => mutateDms())
      .catch(() => {})
  }, [dmId, messages.length])

  if (!dmsLoading && !dm) {
    // ChannelView.tsxのS-03版（2026-09-08・2026-09-10）と同じ考え方だが、DMには非公開チャンネル
    // のような単体の詳細取得API（A-06相当）が無く、A-16（自分が参加しているDM一覧）から該当DMを
    // 引けない場合、それが「そもそも存在しないID」なのか「存在するが自分が参加者ではない」のかを
    // フロント側で区別する情報が無い（バックエンドも一覧に含めない、という形でしか表現していない）。
    // 従来は無言でこの画面が空白のままだったが、ユーザーからの明示的な要望「自分が参加していない
    // DM画面のURLを直接打ち込んだとき用にメッセージを表示させたい」を受け、チャンネル版と同じ
    // 「既に存在しないか、参加権限がありません」という両論併記の考え方を踏襲した明示的な
    // メッセージに差し替えた（無言リダイレクトにはしない）
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center">
        <div className="text-[15px] font-bold text-ink">このダイレクトメッセージは表示できません</div>
        <p className="max-w-[420px] text-[12.5px] leading-relaxed text-ink-subtle">
          既に存在しないか、参加する権限がありません。心当たりがある場合は送信元にご確認ください。
        </p>
        <Link
          to="/"
          className="mt-1.5 rounded-lg border border-line-strong px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700"
        >
          ← ワークスペースに戻る
        </Link>
      </div>
    )
  }

  // 自分専用DM（F-05、is_self=true）はmembersに自分自身が1件だけ入るが、単に自分の氏名を
  // タイトルに出すと「なぜ自分宛てのDMがあるのか」と紛らわしいため、専用の表記にする
  const title = dm ? (dm.is_self ? '自分（メモ）' : dm.members.map((m) => m.name).join('、')) : '読み込み中...'

  const openThread = (messageId: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('thread', messageId)
      return next
    })
  }
  const closeThread = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('thread')
      return next
    })
  }

  // DMごとの通知設定（ユーザーからの明示的な要望「DMの画面のヘッダーにも、チャンネル会話と同じ
  // ように、DMごとの通知設定ボタンを付けて」、2026-09-15）。ChannelView.tsxの
  // handleChannelNotifModeChangedと同じ考え方（NotifModeButton自身が保存前に楽観的に呼び、
  // 保存失敗時は元の値で再度呼んで巻き戻す）だが、DMには単体の詳細取得API（A-06相当）が無いため
  // A-16（useDms）のitems一覧キャッシュだけを直接更新すればよい
  const handleDmNotifModeChanged = (mode: ChannelNotifMode) => {
    if (!dmId) return
    mutateDms(
      (prev) => (prev ? { ...prev, items: prev.items.map((d) => (d.id === dmId ? { ...d, notif_mode: mode } : d)) } : prev),
      { revalidate: false },
    )
  }

  // ヘッダー検索欄（ChannelView.tsxと同じHeaderSearchBarを流用、2026-09-15）でwith:をprefillする
  // 相手。グループDM（3名以上）ではrouters/search.pyのwith:がperson-based（特定の1人が参加している
  // DMを横断的に探す）な設計のため、代表として先頭の相手（dm.membersはAPI側でORDER BY nameのため
  // 決定的）を使う。自分専用DM（is_self）は「相手」が存在しないため付けない（自分のidをwith:に
  // 使うと理論上は自分の入っている全DMがヒットしてしまい、このDM専用の絞り込みにならないため）
  const searchWithMember = dm && !dm.is_self ? dm.members[0] : undefined

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[52px] flex-none items-center gap-2 border-b border-line px-5">
          {dm?.is_self && <span className="text-[15px]">📝</span>}
          <span className="min-w-0 flex-shrink truncate text-[15px] font-bold text-ink">{title}</span>
          <HeaderSearchBar modifier="with" id={searchWithMember?.id} label={searchWithMember?.name} />
          {dm && (
            <NotifModeButton
              endpoint={`/api/dms/${dmId}/notif-mode`}
              label="このDMの通知"
              mode={dm.notif_mode ?? 'default'}
              onChanged={handleDmNotifModeChanged}
              hint="「既定に従う」以外を選ぶと、このDMに限りデスクトップ通知の設定を上書きします。「オフ」はサイドバーの未読バッジも表示しなくなります。DM本体のメッセージは常に自分宛てのため「すべて」と「メンションのみ」は同じ動作になります（スレッド内の返信・メンションには影響しません）。"
            />
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto overflow-x-hidden py-3">
          {hasOlder && (
            <div className="mb-2 flex justify-center">
              <button
                type="button"
                onClick={handleLoadOlder}
                disabled={loadingOlder}
                className="rounded-md border border-line px-2.5 py-1 text-[12px] font-semibold text-ink-muted hover:border-line-strong hover:bg-surface-subtle disabled:opacity-50"
              >
                {loadingOlder ? '読み込み中...' : '▲ 古いメッセージを読み込む'}
              </button>
            </div>
          )}
          <MessageList
            messages={messages}
            emptyMessage="まだ発言がありません。最初のメッセージを送ってみましょう。"
            onOpenThread={openThread}
            openThreadId={threadId}
            onDeleted={removeMessage}
            onReactionToggled={updateMessageReactions}
            onEdited={updateMessage}
            unreadDividerMessageId={unreadDividerMessageId}
            highlightMessageId={highlightId}
          />
        </div>

        <div className="flex-none border-t border-line px-5 py-2.5">
          <Composer
            // key={dmId}: ChannelView.tsxと同じ理由（Composerは会話の識別propを持たず、DM切替時に
            // 再マウントされないため入力途中の本文が残ってしまう不具合、2026-09-14）
            key={dmId}
            placeholder={`${title} にメッセージを送る（@でメンション）`}
            mentionCandidates={mentionCandidates}
            scheduleTarget={{ dm_id: dmId }}
            draftKey={dmId ? `d:${dmId}` : undefined}
            onSend={async (body, mentions: MentionPayload[], attachments: AttachmentPayload[]) => {
              if (!dmId) return
              await apiFetch(`/api/dms/${dmId}/messages`, {
                method: 'POST',
                body: JSON.stringify({ body, mentions, attachments }),
              })
              await mutateMessages()
            }}
          />
        </div>
      </div>

      {threadId && (
        <ThreadPanel
          messageId={threadId}
          parentMessage={messages.find((m) => m.id === threadId) ?? null}
          headerSub={title}
          members={mentionCandidates}
          highlightMessageId={highlightId}
          onClose={closeThread}
          onReplyPosted={() => bumpThreadReplyCount(threadId)}
          onReplyDeleted={() => decrementThreadReplyCount(threadId)}
        />
      )}
    </div>
  )
}
