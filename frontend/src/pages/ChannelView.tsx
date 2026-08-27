import { useEffect, useRef } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useChannel, useChannels } from '../hooks/useChannels'
import { useMessages } from '../hooks/useMessages'
import { useMe } from '../hooks/useMe'
import { apiFetch, ApiError } from '../lib/api'
import MessageList from '../components/MessageList'
import Composer from '../components/Composer'
import ThreadPanel from '../components/ThreadPanel'

// S-03 チャンネル会話＋S-04 スレッド表示（このスライスはメンション・添付・送信予約・要約は未実装）
export default function ChannelView() {
  const { channelId } = useParams<{ channelId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const threadId = searchParams.get('thread')
  const { me } = useMe()
  const { channel, error: channelError } = useChannel(channelId)
  const { mutate: mutateChannelsList } = useChannels()
  const {
    messages, mutate: mutateMessages, bumpThreadReplyCount, removeMessage, decrementThreadReplyCount,
  } = useMessages(channelId ? `/api/channels/${channelId}` : undefined)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages.length])

  useEffect(() => {
    // このチャンネルを開いている間は既読として扱う（未読バッジ用。基本設計書4.2節「設計判断」）。
    // 表示中に新着が来た場合も追従して既読化するため、messages.lengthの変化でも発火させる。
    if (!channelId) return
    apiFetch(`/api/channels/${channelId}/read`, { method: 'POST' })
      .then(() => mutateChannelsList())
      .catch(() => {})
  }, [channelId, messages.length])

  if (channelError instanceof ApiError && (channelError.status === 404 || channelError.status === 403)) {
    // 総論5.9節: 参加していないチャンネルへの直接アクセスはワークスペースへ無言で戻す
    return null
  }

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
        <div className="flex h-[52px] flex-none items-center gap-2.5 border-b border-line px-5">
          <span className="text-base text-ink-subtle">#</span>
          <span className="text-[15px] font-bold text-ink">{channel?.name ?? '読み込み中...'}</span>
          {channel?.topic && <span className="ml-1 truncate text-xs text-ink-subtle">{channel.topic}</span>}
          {(channel?.is_channel_admin || me?.role === 'admin') && (
            <Link
              to={`/channels/${channelId}/settings`}
              className="ml-auto flex-none rounded-[7px] border border-line px-2.5 py-1 text-xs font-semibold text-ink-muted hover:border-line-strong hover:bg-surface-subtle"
            >
              ⚙ チャンネル設定
            </Link>
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-3">
          <MessageList
            messages={messages}
            emptyMessage="まだ発言がありません。最初のメッセージを送ってみましょう。"
            onOpenThread={openThread}
            openThreadId={threadId}
            onDeleted={removeMessage}
          />
        </div>

        <div className="flex-none border-t border-line px-5 py-2.5">
          <Composer
            placeholder={`# ${channel?.name ?? ''} にメッセージを送る`}
            onSend={async (body) => {
              if (!channelId) return
              await apiFetch(`/api/channels/${channelId}/messages`, {
                method: 'POST',
                body: JSON.stringify({ body }),
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
          headerSub={`# ${channel?.name ?? ''}`}
          onClose={closeThread}
          onReplyPosted={() => bumpThreadReplyCount(threadId)}
          onReplyDeleted={() => decrementThreadReplyCount(threadId)}
        />
      )}
    </div>
  )
}
