import { useEffect, useRef } from 'react'
import { useParams, useSearchParams } from 'react-router'
import { useDms } from '../hooks/useDms'
import { useMessages } from '../hooks/useMessages'
import { useUnreadDivider } from '../hooks/useUnreadDivider'
import { useMe } from '../hooks/useMe'
import { apiFetch } from '../lib/api'
import MessageList from '../components/MessageList'
import Composer from '../components/Composer'
import ThreadPanel from '../components/ThreadPanel'

// S-03相当のDM会話＋S-04スレッド表示（ChannelViewのDM版）。ヘッダーはチャンネル名の代わりに相手の氏名を表示する。
// 参加者は開始時に固定のため、詳細取得API（A-06相当）は無くA-16の一覧から該当DMを引く。
// 自分専用DM（F-05、dm.is_self）はタイトルを「自分（メモ）」固定表記にする（自分の氏名をそのまま
// 出すと紛らわしいため）。それ以外の挙動（投稿・スレッド・既読化等）は通常のDMと完全に共通
export default function DmView() {
  const { dmId } = useParams<{ dmId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const threadId = searchParams.get('thread')
  const { me } = useMe()
  const { dms, isLoading: dmsLoading, mutate: mutateDms } = useDms()
  const dm = dms.find((d) => d.id === dmId)
  const {
    messages, mutate: mutateMessages, bumpThreadReplyCount, removeMessage, decrementThreadReplyCount,
  } = useMessages(dmId ? `/api/dms/${dmId}` : undefined)
  const unreadDividerMessageId = useUnreadDivider(dmId, dm?.unread_count, messages, me?.id)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages.length])

  useEffect(() => {
    // このDMを開いている間は既読として扱う（未読バッジ用。ChannelViewと同じ考え方）
    if (!dmId) return
    apiFetch(`/api/dms/${dmId}/read`, { method: 'POST' })
      .then(() => mutateDms())
      .catch(() => {})
  }, [dmId, messages.length])

  if (!dmsLoading && !dm) {
    // 総論5.9節: 参加していないDMへの直接アクセスはワークスペースへ無言で戻す
    return null
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

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[52px] flex-none items-center gap-2 border-b border-line px-5">
          {dm?.is_self && <span className="text-[15px]">📝</span>}
          <span className="text-[15px] font-bold text-ink">{title}</span>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-3">
          <MessageList
            messages={messages}
            emptyMessage="まだ発言がありません。最初のメッセージを送ってみましょう。"
            onOpenThread={openThread}
            openThreadId={threadId}
            onDeleted={removeMessage}
            unreadDividerMessageId={unreadDividerMessageId}
          />
        </div>

        <div className="flex-none border-t border-line px-5 py-2.5">
          <Composer
            placeholder={`${title} にメッセージを送る`}
            scheduleTarget={{ dm_id: dmId }}
            onSend={async (body, _mentions, attachments) => {
              if (!dmId) return
              await apiFetch(`/api/dms/${dmId}/messages`, {
                method: 'POST',
                body: JSON.stringify({ body, attachments }),
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
          onClose={closeThread}
          onReplyPosted={() => bumpThreadReplyCount(threadId)}
          onReplyDeleted={() => decrementThreadReplyCount(threadId)}
        />
      )}
    </div>
  )
}
