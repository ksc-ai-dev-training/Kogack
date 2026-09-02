import { useEffect, useRef, useState } from 'react'
import { useThread } from '../hooks/useThread'
import { apiFetch } from '../lib/api'
import MessageList, { Avatar, formatTime, renderMessageBody } from './MessageList'
import Composer from './Composer'
import ProfileCard from './ProfileCard'
import { useToast } from './Toast'
import type { AttachmentPayload, ChannelMember, MentionPayload, Message } from '../types'

// S-04 スレッド表示（画面モックアップ S-04）。S-03/DmViewの右側に重ねて表示するパネル。
// 元発言はChannelView/DmView側で既に読み込み済みのmessages一覧から渡してもらう
// （A-13は返信一覧のみを返す設計のため、元発言の内容自体を取りに行く専用APIは無い）。
export default function ThreadPanel({
  messageId,
  parentMessage,
  headerSub,
  members,
  aiPersonaName,
  onClose,
  onReplyPosted,
  onReplyDeleted,
}: {
  messageId: string
  parentMessage: Message | null
  headerSub: string
  /** F-41 @メンション用（チャンネルのスレッドのみ渡す。DMのスレッドでは渡さない） */
  members?: ChannelMember[]
  /** AIメンションのハイライト用（チャンネルのスレッドのみ渡す。DMのスレッドでは渡さない） */
  aiPersonaName?: string
  onClose: () => void
  onReplyPosted?: () => void
  onReplyDeleted?: () => void
}) {
  const { replies, mutate: mutateReplies } = useThread(messageId)
  const bodyRef = useRef<HTMLDivElement>(null)
  // F-40 プロフィールカード（元発言のヘッダーはMessageListの外で個別に描画しているため、
  // ここだけ別途状態を持つ）
  const [parentProfileOpen, setParentProfileOpen] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const toast = useToast()

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [replies.length])

  const send = async (body: string, mentions: MentionPayload[], attachments: AttachmentPayload[]) => {
    await apiFetch(`/api/messages/${messageId}/thread`, {
      method: 'POST',
      body: JSON.stringify({ body, mentions, attachments }),
    })
    await mutateReplies()
    onReplyPosted?.()
  }

  // A-15: このスレッド全体の要約（F-14）。チャンネルのスレッドのみ対象（DMのスレッドにはAI機能が
  // 無いため、channel_idを持つ元発言のときだけボタンを表示する）。要約結果はこのスレッドへの
  // 返信として投稿されるため、返信一覧を再取得して生成中プレースホルダをすぐ表示する。
  const summarizeThread = async () => {
    if (!parentMessage?.channel_id) return
    setSummarizing(true)
    try {
      await apiFetch(`/api/channels/${parentMessage.channel_id}/summarize`, {
        method: 'POST',
        body: JSON.stringify({ thread_id: messageId }),
      })
      await mutateReplies()
      onReplyPosted?.()
    } catch (e) {
      toast(e instanceof Error ? e.message : '要約に失敗しました', 'error')
    } finally {
      setSummarizing(false)
    }
  }

  return (
    <aside className="flex w-[380px] flex-none flex-col border-l border-line-strong bg-surface shadow-[-4px_0_16px_rgba(16,24,40,0.05)]">
      <div className="flex h-[52px] flex-none items-center gap-2.5 border-b border-line px-4">
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-bold text-ink">スレッド</span>
          <span className="truncate text-[11px] text-ink-subtle">{headerSub}</span>
        </div>
        {parentMessage?.channel_id && (
          <button
            type="button"
            disabled={summarizing}
            onClick={summarizeThread}
            title="このスレッド全体を要約します（F-14）"
            className="ml-auto flex-none rounded-[7px] border border-accent-100 bg-accent-50 px-2 py-1 text-[11px] font-semibold text-accent-700 hover:bg-accent-100 disabled:opacity-50"
          >
            📝 {summarizing ? '要約中...' : '要約'}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          title="閉じる"
          className={`flex h-[26px] w-[26px] flex-none items-center justify-center rounded-md text-ink-subtle hover:bg-surface-muted ${
            parentMessage?.channel_id ? '' : 'ml-auto'
          }`}
        >
          ✕
        </button>
      </div>

      <div ref={bodyRef} className="flex-1 overflow-y-auto py-1.5">
        {parentMessage && (
          <div className="relative flex gap-2.5 border-b border-line px-4 py-3">
            <Avatar
              message={parentMessage}
              onClick={
                parentMessage.sender_type === 'human' && parentMessage.sender_user_id
                  ? () => setParentProfileOpen(true)
                  : undefined
              }
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span
                  onClick={
                    parentMessage.sender_type === 'human' && parentMessage.sender_user_id
                      ? () => setParentProfileOpen(true)
                      : undefined
                  }
                  className={`text-sm font-bold text-ink ${
                    parentMessage.sender_type === 'human' && parentMessage.sender_user_id
                      ? 'cursor-pointer hover:underline'
                      : ''
                  }`}
                >
                  {parentMessage.sender_name ?? '(不明)'}
                </span>
                <span className="text-[11px] text-ink-subtle">{formatTime(parentMessage.created_at)}</span>
              </div>
              <div className="whitespace-pre-wrap text-[13.5px] leading-[1.75] text-ink">
                {renderMessageBody(parentMessage.body, parentMessage.blocks, members, aiPersonaName)}
              </div>
            </div>
            {parentProfileOpen && parentMessage.sender_user_id && (
              <ProfileCard userId={parentMessage.sender_user_id} onClose={() => setParentProfileOpen(false)} />
            )}
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
          members={members}
          aiPersonaName={aiPersonaName}
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
        <Composer
          placeholder="スレッドに返信"
          onSend={send}
          mentionCandidates={members?.filter((m) => m.is_active)}
          scheduleTarget={{
            channel_id: parentMessage?.channel_id ?? undefined,
            dm_id: parentMessage?.dm_id ?? undefined,
            thread_parent_id: messageId,
          }}
        />
      </div>
    </aside>
  )
}
