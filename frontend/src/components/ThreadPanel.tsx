import { useEffect, useRef, useState } from 'react'
import { useThread } from '../hooks/useThread'
import { apiFetch } from '../lib/api'
import MessageList, {
  Avatar, EmojiGridPopover, ReactionPills, ReactionQuickButtons, formatTime, isEmojiOnlyBody, renderMessageBody,
} from './MessageList'
import Composer, { type MentionCandidate } from './Composer'
import ProfileCard from './ProfileCard'
import { useToast } from './Toast'
import type { AttachmentPayload, CitationPayload, MentionPayload, MentionSourceMember, Message } from '../types'

// S-04 スレッド表示（画面モックアップ S-04）。S-03/DmViewの右側に重ねて表示するパネル。
// 元発言はChannelView/DmView側で既に読み込み済みのmessages一覧から渡してもらう
// （A-13は返信一覧のみを返す設計のため、元発言の内容自体を取りに行く専用APIは無い）。

// パネル幅をマウスドラッグで変更できるようにする（ユーザーからの明示的な要望）。幅は
// localStorageに保存し次回スレッドを開いたときも保持する（サーバー同期は不要な、個人の
// 画面設定に過ぎないため。プライベートブラウジング等でlocalStorageが使えない場合は
// 既定値にフォールバックする）
const THREAD_WIDTH_STORAGE_KEY = 'kogack_thread_panel_width'
const THREAD_WIDTH_DEFAULT = 380
const THREAD_WIDTH_MIN = 320
const THREAD_WIDTH_MAX = 720

function readStoredThreadWidth(): number {
  try {
    const raw = localStorage.getItem(THREAD_WIDTH_STORAGE_KEY)
    const n = raw ? Number(raw) : NaN
    if (Number.isFinite(n)) return Math.min(THREAD_WIDTH_MAX, Math.max(THREAD_WIDTH_MIN, n))
  } catch {
    // noop（プライベートブラウジング等でlocalStorageが使えない場合は既定値のまま）
  }
  return THREAD_WIDTH_DEFAULT
}

export default function ThreadPanel({
  messageId,
  parentMessage,
  headerSub,
  members,
  aiPersonaName,
  aiIsEnabled,
  aiPersonaIconUrl,
  highlightMessageId,
  onClose,
  onReplyPosted,
  onReplyDeleted,
}: {
  messageId: string
  parentMessage: Message | null
  headerSub: string
  /** F-41 @メンション用。チャンネル・DMどちらのスレッドでも渡せる（バグ修正2026-09-04でDMも対応） */
  members?: MentionSourceMember[]
  /** AIメンションのハイライト用（チャンネルのスレッドのみ渡す。DMのスレッドでは渡さない） */
  aiPersonaName?: string
  /** F-41メンション候補にチャンネルAIを含めるかどうか（ChannelViewのmentionCandidatesWithAiと
   * 同じ考え方をスレッド返信にも適用する。ユーザーからの明示的な要望でスレッド内メンションに
   * 対応した際に追加。DMのスレッドでは渡さない） */
  aiIsEnabled?: boolean
  aiPersonaIconUrl?: string | null
  /** S-05横断検索の結果クリックでのハイライトジャンプ先（ユーザーからの明示的な要望）。
   * ChannelView/DmViewから?highlight=をそのまま渡す。この返信一覧に該当が無ければ何も起きない */
  highlightMessageId?: string | null
  onClose: () => void
  onReplyPosted?: () => void
  onReplyDeleted?: () => void
}) {
  const { replies, mutate: mutateReplies, updateReplyReactions } = useThread(messageId)
  const bodyRef = useRef<HTMLDivElement>(null)

  // パネル幅のドラッグリサイズ。ドラッグ開始時のマウスX座標・幅をdragStartRefに記録し、
  // resizing中はwindow全体でmousemove/mouseupを監視する（マウスがパネル外へ出ても追従させるため）。
  // latestWidthRefは直近のmousemoveで計算した幅を保持し、mouseup時点でそれをlocalStorageへ
  // 保存する（onMouseUpのクロージャがuseEffectの依存配列的に古いwidthを参照してしまうのを避けるため）
  const [threadWidth, setThreadWidth] = useState(readStoredThreadWidth)
  const [resizingThread, setResizingThread] = useState(false)
  const dragStartRef = useRef<{ x: number; width: number } | null>(null)
  const latestWidthRef = useRef(threadWidth)
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    dragStartRef.current = { x: e.clientX, width: threadWidth }
    setResizingThread(true)
  }
  useEffect(() => {
    if (!resizingThread) return
    // ウィンドウが狭い場合でも本体側の会話画面が潰れきらないよう、最大幅はウィンドウ幅からも制限する
    const dynamicMax = Math.min(THREAD_WIDTH_MAX, window.innerWidth - 300)
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragStartRef.current) return
      // 左端のハンドルをドラッグする想定のため、マウスが左に動く（dx正）ほど幅が広がる
      const dx = dragStartRef.current.x - ev.clientX
      const next = Math.min(dynamicMax, Math.max(THREAD_WIDTH_MIN, dragStartRef.current.width + dx))
      latestWidthRef.current = next
      setThreadWidth(next)
    }
    const onMouseUp = () => {
      setResizingThread(false)
      try {
        localStorage.setItem(THREAD_WIDTH_STORAGE_KEY, String(latestWidthRef.current))
      } catch {
        // noop
      }
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [resizingThread])
  // F-41 メンション候補。ChannelView.tsxのmentionCandidatesWithAiと同じ考え方（ユーザーからの
  // 明示的な要望「スレッド内のメンション先候補にもAIを入れてほしい」で追加）。選択してもAIメンションは
  // ID参照化しない（Composer.MentionCandidate.isAi参照）
  const mentionCandidatesWithAi: MentionCandidate[] = aiIsEnabled
    ? [
        { id: 'ai', name: aiPersonaName ?? 'Kogack AI', isAi: true, picture_url: aiPersonaIconUrl },
        ...(members?.filter((m) => m.is_active) ?? []),
      ]
    : (members?.filter((m) => m.is_active) ?? [])
  // F-40 プロフィールカード（元発言のヘッダーはMessageListの外で個別に描画しているため、
  // ここだけ別途状態を持つ）
  const [parentProfileOpen, setParentProfileOpen] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const toast = useToast()

  // 元発言への絵文字リアクション（MessageListを経由せずここで個別に描画しているため、
  // 返信一覧とは別に扱う）。返信側と異なりChannelView/DmView側のmessages一覧を直接
  // 更新する手段が無いため、ここでは楽観的更新をせず、次のポーリング（channel/DM一覧は
  // 2秒間隔）で自然に反映されるのを待つ（数秒以内には反映される）。anchorはEmojiGridPopoverを
  // document.bodyへポータル配置する基準（ユーザーからの報告「投稿欄の裏に隠れて見えない」の修正）
  const [parentEmojiPickerAnchor, setParentEmojiPickerAnchor] = useState<DOMRect | null>(null)
  const toggleParentReaction = async (emoji: string) => {
    if (!parentMessage) return
    setParentEmojiPickerAnchor(null)
    try {
      await apiFetch(`/api/messages/${parentMessage.id}/reactions/toggle`, {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      })
    } catch (e) {
      toast(e instanceof Error ? e.message : 'リアクションに失敗しました', 'error')
    }
  }

  // ハイライト対象がこのスレッドの返信一覧に実在する間は、末尾自動スクロールを止める
  // （MessageList側のscrollIntoViewと競合させないため。ChannelView本体と同じ考え方）
  const highlightInReplies = !!highlightMessageId && replies.some((r) => r.id === highlightMessageId)

  useEffect(() => {
    if (highlightInReplies) return
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight })
  }, [replies.length, highlightInReplies])

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
    <aside
      className="relative flex flex-none flex-col border-l border-line-strong bg-surface shadow-[-4px_0_16px_rgba(16,24,40,0.05)]"
      style={{ width: threadWidth }}
    >
      {/* 左端のリサイズハンドル（ユーザーからの明示的な要望「スレッドの枠の横幅をマウスで変更
          できるようにしたい」）。境界線（border-l）をまたぐ形で少し広めの当たり判定を確保し、
          ホバー時にアクセントカラーで存在を示す */}
      <div
        onMouseDown={startResize}
        title="ドラッグして幅を変更"
        className={`absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize select-none ${
          resizingThread ? 'bg-accent-600/40' : 'hover:bg-accent-600/25'
        }`}
      />
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
          <div className="group relative flex gap-2.5 border-b border-line px-4 py-3">
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
              <div
                className={`whitespace-pre-wrap break-words text-ink ${
                  isEmojiOnlyBody(parentMessage.body) ? 'text-[32px] leading-snug' : 'text-[13.5px] leading-[1.75]'
                }`}
              >
                {renderMessageBody(parentMessage.body, parentMessage.blocks, members, aiPersonaName)}
              </div>
              {parentMessage.sender_type === 'ai' && parentMessage.generation_status !== 'generating' && (
                // F-30（MessageList.tsxと同じ）。元発言はMessageListを経由せずここで個別に描画しているため
                // 別途対応が必要（AI発言に人間がスレッド返信した場合、元発言側にも表示する）
                <div className="mt-[7px] flex items-center gap-[5px] text-[11px] text-ink-subtle">
                  ⚠ AIの回答には誤りが含まれる場合があります。
                </div>
              )}
              {/* F-20 回答根拠の提示（Slice 3、2026-09-09。MessageList.tsxと同じ理由で個別に描画） */}
              {parentMessage.sender_type === 'ai' && parentMessage.generation_status !== 'generating' && (parentMessage.blocks ?? []).some((b) => b.block_type === 'citation') && (
                <div className="mt-[5px] flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-ink-subtle">
                  <span>📄 参照:</span>
                  {(parentMessage.blocks ?? [])
                    .filter((b) => b.block_type === 'citation')
                    .map((b, i) => (
                      <span key={i} className="rounded bg-bot-bg px-1.5 py-0.5 text-bot-text">
                        {(b.payload as CitationPayload).folder_name}
                      </span>
                    ))}
                </div>
              )}
              <ReactionPills reactions={parentMessage.reactions} onToggle={toggleParentReaction} />
            </div>
            {/* 元発言への絵文字リアクション（ユーザーからの明示的な要望）。MessageList.tsxと同じ
                「ホバー時に右上へ重ねて表示」の配置＋1枚の枠（枠線＋背景＋影）で囲む浮遊ツールバー。
                返信・削除ボタンはここには元々無いためクイックボタン＋ピッカーだけを置く */}
            <div className="absolute right-3 top-1 hidden items-center gap-0.5 rounded-md border border-line bg-surface px-1 py-0.5 shadow-sm group-hover:flex">
              <ReactionQuickButtons
                onToggle={toggleParentReaction}
                pickerOpen={!!parentEmojiPickerAnchor}
                onTogglePicker={(anchor) => setParentEmojiPickerAnchor((v) => (v ? null : anchor))}
              />
            </div>
            {parentEmojiPickerAnchor && (
              <EmojiGridPopover
                anchor={parentEmojiPickerAnchor}
                onSelect={toggleParentReaction}
                onClose={() => setParentEmojiPickerAnchor(null)}
              />
            )}
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
          highlightMessageId={highlightMessageId}
          onDeleted={() => {
            mutateReplies()
            onReplyDeleted?.()
          }}
          onReactionToggled={updateReplyReactions}
        />

        <p className="mx-4 mb-3 mt-1 rounded-md border border-line bg-surface-subtle px-2.5 py-2 text-[11px] leading-relaxed text-ink-subtle">
          このスレッド内のやり取りは本体のタイムラインには流れません。
        </p>
      </div>

      <div className="flex-none border-t border-line px-4 py-2.5">
        <Composer
          placeholder="スレッドに返信"
          onSend={send}
          mentionCandidates={mentionCandidatesWithAi}
          aiPersonaName={aiPersonaName}
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
