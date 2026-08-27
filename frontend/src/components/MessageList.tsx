import { avatarColorFor } from '../lib/avatarColor'
import { useMe } from '../hooks/useMe'
import { apiFetch } from '../lib/api'
import { useToast } from './Toast'
import { useConfirm } from './ui/ConfirmDialog'
import type { Message } from '../types'

export function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function dayKey(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function formatDaySeparator(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })
}

function DaySeparator({ label }: { label: string }) {
  return (
    <div className="mx-5 my-2.5 flex items-center gap-2.5 text-[11px] font-semibold text-ink-subtle">
      <span className="h-px flex-1 bg-line" />
      {label}
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}

export function Avatar({ message }: { message: Message }) {
  if (message.sender_type === 'bot') {
    return (
      <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] bg-bot-bg text-base">
        🔔
      </div>
    )
  }
  if (message.sender_type === 'ai') {
    return (
      <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] bg-gradient-to-br from-accent-600 to-accent-700 text-[11px] font-bold text-white">
        AI
      </div>
    )
  }
  const seed = message.sender_user_id ?? message.sender_name ?? message.id
  return (
    <div
      className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full text-xs font-bold text-white"
      style={{ background: avatarColorFor(seed) }}
    >
      {(message.sender_name ?? '?').slice(0, 1)}
    </div>
  )
}

// S-03・S-04共通の発言一覧（詳細設計書 画面設計11.3節）。スクロールコンテナは呼び出し元が持つ
// （S-04のthread-bodyは元発言・件数・返信一覧をひとつのスクロール領域として扱うため）。
// onOpenThreadを渡すと「N件の返信」導線とホバー時の「返信」ボタンを表示する（S-04スレッド表示への導線）。
// 削除（A-12）は投稿者本人またはadminのみホバー時に表示し、確認ダイアログを経由する。
export default function MessageList({
  messages,
  emptyMessage,
  onOpenThread,
  openThreadId,
  onDeleted,
  showDaySeparators = true,
}: {
  messages: Message[]
  emptyMessage?: string
  onOpenThread?: (messageId: string) => void
  openThreadId?: string | null
  onDeleted?: (messageId: string) => void
  /** S-04スレッド返信欄では表示しない（画面モックアップに合わせる。既定はtrue） */
  showDaySeparators?: boolean
}) {
  const { me } = useMe()
  const confirm = useConfirm()
  const toast = useToast()

  const deleteMessage = async (messageId: string) => {
    const ok = await confirm({
      title: '発言を削除',
      message: 'この発言を削除しますか？ この操作は取り消せません。',
      confirmLabel: '削除する',
      danger: true,
    })
    if (!ok) return
    try {
      await apiFetch(`/api/messages/${messageId}`, { method: 'DELETE' })
      onDeleted?.(messageId)
      toast('発言を削除しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '削除に失敗しました', 'error')
    }
  }

  if (messages.length === 0) {
    return emptyMessage ? <p className="px-5 py-3 text-sm text-ink-subtle">{emptyMessage}</p> : null
  }

  return (
    <>
      {messages.map((m, i) => {
        const canDelete = !!me && (m.sender_user_id === me.id || me.role === 'admin')
        const showReplyButton = onOpenThread && !(m.thread_reply_count ?? 0)
        const isNewDay = showDaySeparators && (i === 0 || dayKey(messages[i - 1].created_at) !== dayKey(m.created_at))

        return (
          <div key={m.id}>
            {isNewDay && <DaySeparator label={formatDaySeparator(m.created_at)} />}
            <div
              className={`group relative flex gap-2.5 px-5 py-[7px] ${
                openThreadId === m.id ? 'bg-accent-50' : 'hover:bg-surface-subtle'
              }`}
            >
              <Avatar message={m} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-[7px]">
                  <span className="text-[13px] font-bold text-ink">{m.sender_name ?? '(不明)'}</span>
                  {m.sender_type === 'bot' && (
                    <span className="rounded bg-bot-bg px-1.5 py-0.5 text-[10px] font-bold text-bot-text">BOT</span>
                  )}
                  {m.sender_type === 'ai' && (
                    <span className="rounded bg-accent-100 px-1.5 py-0.5 text-[10px] font-bold text-accent-700">
                      AI
                    </span>
                  )}
                  <span className="text-[11px] text-ink-subtle">{formatTime(m.created_at)}</span>
                </div>
                <div className="mt-0.5 whitespace-pre-wrap text-[13.5px] leading-[1.75] text-ink">{m.body}</div>
                {onOpenThread && (m.thread_reply_count ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => onOpenThread(m.id)}
                    className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-accent-700 hover:border-line-strong hover:bg-surface-subtle"
                  >
                    💬 {m.thread_reply_count}件の返信{openThreadId === m.id ? ' — スレッドを表示中' : ''}
                  </button>
                )}
              </div>
              {(showReplyButton || canDelete) && (
                // 常時flowに置くと表示/非表示の切替で下の発言がガタつくため、絶対配置でホバー時だけ重ねて出す
                <div className="absolute right-4 top-1 hidden items-center gap-1 group-hover:flex">
                  {showReplyButton && (
                    <button
                      type="button"
                      onClick={() => onOpenThread(m.id)}
                      className="rounded border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-muted shadow-sm hover:text-accent-700"
                    >
                      返信
                    </button>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => deleteMessage(m.id)}
                      className="rounded border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-muted shadow-sm hover:text-danger-text"
                    >
                      削除
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
