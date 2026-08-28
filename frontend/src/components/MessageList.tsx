import { useState, type ReactNode } from 'react'
import { avatarColorFor } from '../lib/avatarColor'
import { useMe } from '../hooks/useMe'
import { apiFetch } from '../lib/api'
import { useToast } from './Toast'
import { useConfirm } from './ui/ConfirmDialog'
import ProfileCard from './ProfileCard'
import type { ChannelMember, Message } from '../types'

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

function UnreadDivider() {
  return (
    <div className="mx-5 my-2.5 flex items-center gap-2.5 text-[11px] font-semibold text-accent-700">
      <span className="h-px flex-1 bg-accent-600" />
      ここから未読メッセージ
      <span className="h-px flex-1 bg-accent-600" />
    </div>
  )
}

// F-41 @メンションの描画。本文中の「@display_name_snapshot」を検出し、target_user_idを
// 現在のチャンネル参加者一覧で解決した最新の表示名でハイライト表示する（05-1_詳細設計書_DB設計.html
// 3.7節「表示時はtarget_user_idを解決して現在の表示名・アイコンを描画」）。A-62プロフィール編集の
// 実装（F-39）により、対象者が後から表示名を変更した場合はdisplay_name_snapshotと現在名が食い違う
// ことがあり、この場合も現在名の方で描画し直す（本文中の静的テキストは検索の起点にのみ使う）。
export function renderMessageBody(body: string, blocks: Message['blocks'], members?: ChannelMember[]): ReactNode {
  const mentions = (blocks ?? []).filter(
    (b): b is { block_type: 'mention'; payload: { target_user_id: string; display_name_snapshot: string }; sort_order: number } =>
      b.block_type === 'mention',
  )
  if (mentions.length === 0) return body

  const matches: { start: number; end: number; label: string }[] = []
  for (const block of mentions) {
    const current = members?.find((m) => m.id === block.payload.target_user_id)?.name
    const label = `@${current ?? block.payload.display_name_snapshot}`
    const idx = body.indexOf(`@${block.payload.display_name_snapshot}`)
    if (idx !== -1) matches.push({ start: idx, end: idx + block.payload.display_name_snapshot.length + 1, label })
  }
  matches.sort((a, b) => a.start - b.start)

  const nodes: ReactNode[] = []
  let cursor = 0
  matches.forEach((m, i) => {
    if (m.start < cursor) return
    if (m.start > cursor) nodes.push(body.slice(cursor, m.start))
    nodes.push(
      <span key={i} className="rounded bg-accent-100 px-1 font-semibold text-accent-700">
        {m.label}
      </span>,
    )
    cursor = m.end
  })
  if (cursor < body.length) nodes.push(body.slice(cursor))
  return nodes
}

export function Avatar({ message, onClick }: { message: Message; onClick?: () => void }) {
  // アイコン画像を設定済みならそれを表示し、無ければ種別ごとのフォールバックにする
  // （画面設計11.6節 Avatarコンポーネント定義。メッセージ一覧・サイドバー・メンバー一覧等で共通の考え方）。
  // AI発言はペルソナアイコン（未設定なら後段の「AI」表示にフォールバック）、人間の発言は
  // プロフィール画像が対象（services/ai_agent.py・A-62）。BOT発言（F-36/F-38）は送り主アイコン画像
  // （bot_icon_url、この分岐の対象）を優先し、次点でbot_icon（絵文字、次の分岐）、
  // どちらも未設定なら🔔（F-43システム通知と同じ既定表示）にフォールバックする
  if (message.sender_picture_url) {
    return (
      <img
        src={message.sender_picture_url}
        alt=""
        referrerPolicy="no-referrer"
        onClick={onClick}
        className={`h-[34px] w-[34px] flex-none rounded-full object-cover ${onClick ? 'cursor-pointer' : ''}`}
      />
    )
  }
  if (message.sender_type === 'bot') {
    return (
      <div className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[9px] bg-bot-bg text-base">
        {message.bot_icon || '🔔'}
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
      onClick={onClick}
      className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full text-xs font-bold text-white ${onClick ? 'cursor-pointer' : ''}`}
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
  members,
  unreadDividerMessageId,
}: {
  messages: Message[]
  emptyMessage?: string
  onOpenThread?: (messageId: string) => void
  openThreadId?: string | null
  onDeleted?: (messageId: string) => void
  /** S-04スレッド返信欄では表示しない（画面モックアップに合わせる。既定はtrue） */
  showDaySeparators?: boolean
  /** F-41 @メンションの表示名解決に使う（チャンネル参加者一覧。DM会話では渡さない） */
  members?: ChannelMember[]
  /** このメッセージの直前に「ここから未読メッセージ」区切り線を表示する（useUnreadDivider） */
  unreadDividerMessageId?: string | null
}) {
  const { me } = useMe()
  const confirm = useConfirm()
  const toast = useToast()
  // F-40 プロフィールカード。開いている対象はメッセージid単位で持つ（カードは各メッセージ行に
  // 相対配置するため。表示するのはsender_user_idのプロフィール）
  const [profileFor, setProfileFor] = useState<string | null>(null)

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
        // システム通知（F-43）は参加・退出の記録として残すことに意味があるため、返信・削除の対象外とする
        // （F-36定期投稿・F-38自動応答トリガーは内容のあるBOT発言のため対象外にしない。基本設計書6.2節「設計判断」）
        const isSystemNotice = m.sender_type === 'bot' && m.sender_name === 'システム通知'
        const canDelete = !isSystemNotice && !!me && (m.sender_user_id === me.id || me.role === 'admin')
        const showReplyButton = !isSystemNotice && onOpenThread && !(m.thread_reply_count ?? 0)
        const isNewDay = showDaySeparators && (i === 0 || dayKey(messages[i - 1].created_at) !== dayKey(m.created_at))

        return (
          <div key={m.id}>
            {isNewDay && <DaySeparator label={formatDaySeparator(m.created_at)} />}
            {unreadDividerMessageId === m.id && <UnreadDivider />}
            <div
              className={`group relative flex gap-2.5 px-5 py-[7px] ${
                openThreadId === m.id ? 'bg-accent-50' : 'hover:bg-surface-subtle'
              }`}
            >
              <Avatar
                message={m}
                onClick={
                  m.sender_type === 'human' && m.sender_user_id
                    ? () => setProfileFor(m.id)
                    : undefined
                }
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-[7px]">
                  <span
                    onClick={
                      m.sender_type === 'human' && m.sender_user_id ? () => setProfileFor(m.id) : undefined
                    }
                    className={`text-[13px] font-bold text-ink ${
                      m.sender_type === 'human' && m.sender_user_id ? 'cursor-pointer hover:underline' : ''
                    }`}
                  >
                    {m.sender_name ?? '(不明)'}
                  </span>
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
                {m.generation_status === 'generating' ? (
                  <div className="mt-0.5 flex items-center gap-1 text-[12.5px] text-ink-subtle">
                    <span className="inline-flex gap-[3px]">
                      <span className="ai-typing-dot h-[5px] w-[5px] rounded-full bg-ink-subtle" />
                      <span className="ai-typing-dot h-[5px] w-[5px] rounded-full bg-ink-subtle [animation-delay:.2s]" />
                      <span className="ai-typing-dot h-[5px] w-[5px] rounded-full bg-ink-subtle [animation-delay:.4s]" />
                    </span>
                    生成中…
                  </div>
                ) : (
                  <div className="mt-0.5 whitespace-pre-wrap text-[13.5px] leading-[1.75] text-ink">
                    {renderMessageBody(m.body, m.blocks, members)}
                  </div>
                )}
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
              {profileFor === m.id && m.sender_user_id && (
                <ProfileCard userId={m.sender_user_id} onClose={() => setProfileFor(null)} />
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
