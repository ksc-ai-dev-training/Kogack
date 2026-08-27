import { useEffect, useRef } from 'react'
import { useThread } from '../hooks/useThread'
import { apiFetch } from '../lib/api'
import MessageList, { Avatar, formatTime } from './MessageList'
import Composer from './Composer'
import type { Message } from '../types'

// S-04 スレッド表示（画面モックアップ S-04）。S-03/DmViewの右側に重ねて表示するパネル。
// 元発言はChannelView/DmView側で既に読み込み済みのmessages一覧から渡してもらう
// （A-13は返信一覧のみを返す設計のため、元発言の内容自体を取りに行く専用APIは無い）。
export default function ThreadPanel({
  messageId,
  parentMessage,
  headerSub,
  onClose,
  onReplyPosted,
  onReplyDeleted,
}: {
  messageId: string
  parentMessage: Message | null
  headerSub: string
  onClose: () => void
  onReplyPosted?: () => void
  onReplyDeleted?: () => void
}) {
  const { replies, mutate: mutateReplies } = useThread(messageId)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [replies.length])

  const send = async (body: string) => {
    await apiFetch(`/api/messages/${messageId}/thread`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    })
    await mutateReplies()
    onReplyPosted?.()
  }

  return (
    <aside className="flex w-[380px] flex-none flex-col border-l border-line-strong bg-surface shadow-[-4px_0_16px_rgba(16,24,40,0.05)]">
      <div className="flex h-[52px] flex-none items-center gap-2.5 border-b border-line px-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-bold text-ink">スレッド</span>
          <span className="truncate text-[11px] text-ink-subtle">{headerSub}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="閉じる"
          className="ml-auto flex h-[26px] w-[26px] flex-none items-center justify-center rounded-md text-ink-subtle hover:bg-surface-muted"
        >
          ✕
        </button>
      </div>

      <div ref={bodyRef} className="flex-1 overflow-y-auto py-1.5">
        {parentMessage && (
          <div className="flex gap-2.5 border-b border-line px-4 py-3">
            <Avatar message={parentMessage} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="text-sm font-bold text-ink">{parentMessage.sender_name ?? '(不明)'}</span>
                <span className="text-[11px] text-ink-subtle">{formatTime(parentMessage.created_at)}</span>
              </div>
              <div className="whitespace-pre-wrap text-[13.5px] leading-[1.75] text-ink">{parentMessage.body}</div>
            </div>
          </div>
        )}

        <div className="my-3 flex items-center gap-2.5 px-4 text-[11px] font-semibold text-ink-subtle">
          <span className="h-px flex-1 bg-line" />
          {replies.length > 0 ? `${replies.length}件の返信` : 'まだ返信がありません'}
          <span className="h-px flex-1 bg-line" />
        </div>

        <MessageList
          messages={replies}
          showDaySeparators={false}
          onDeleted={() => {
            mutateReplies()
            onReplyDeleted?.()
          }}
        />

        <p className="mx-4 mb-3 mt-1 rounded-md border border-line bg-surface-subtle px-2.5 py-2 text-[11px] leading-relaxed text-ink-subtle">
          このスレッド内のやり取りは本体のタイムラインには流れません。
        </p>
      </div>

      <div className="flex-none border-t border-line px-4 py-2.5">
        <Composer placeholder="スレッドに返信" onSend={send} />
      </div>
    </aside>
  )
}
