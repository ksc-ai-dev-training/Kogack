import { useEffect, useRef, useState } from 'react'
import { avatarColorFor } from '../lib/avatarColor'
import { apiFetch } from '../lib/api'
import { useToast } from './Toast'
import type { MentionPayload, ScheduleTarget } from '../types'

const MIN_ROWS = 2
const MAX_ROWS = 10

export interface MentionCandidate {
  id: string
  name: string
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

// 送信予約ポップオーバーを開いたときの日時欄の既定値（F-35）。5分後を初期値にし、
// 「未来の日時を指定してください」のバリデーションに即座に引っかからないようにする。
function defaultScheduleDateTime(): { date: string; time: string } {
  const d = new Date(Date.now() + 5 * 60 * 1000)
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  }
}

// 「@」（全角「＠」も同様に扱う。IME入力時に全角になりやすいため）の直後、空白を挟まずカーソルまで
// 続く文字列をメンション候補の絞り込みクエリとして検出する（F-41）。「@」の直前が空白または本文の
// 先頭でない場合はメンションの開始とみなさない。
function detectMentionQuery(text: string, cursor: number): { atIndex: number; query: string } | null {
  const uptoCursor = text.slice(0, cursor)
  const atIndex = Math.max(uptoCursor.lastIndexOf('@'), uptoCursor.lastIndexOf('＠'))
  if (atIndex === -1) return null
  const query = uptoCursor.slice(atIndex + 1)
  if (/[\s\n]/.test(query)) return null
  const before = uptoCursor[atIndex - 1]
  if (before !== undefined && !/\s/.test(before)) return null
  return { atIndex, query }
}

// S-03・S-04共通の投稿欄（詳細設計書 画面設計11.3節）。呼び出し元はAPI呼び出し（A-11/A-14/A-19）
// とmutate()だけを担い、送信中状態・エラートーストはこちらで一元管理する。
// mentionCandidatesを渡すと「@」入力でF-41のオートコンプリートが有効になる（チャンネル会話のみ。
// DM会話では候補元＝A-46がチャンネル専用のため渡さない）。
// scheduleTargetを渡すとF-35の送信予約ボタンが有効になる（チャンネル・DM・スレッド返信いずれも
// 対応。送信予約自体はComposerがA-50を直接呼ぶ。設計書のComposerがchannelId/threadParentIdを
// 直接受け取る想定とは異なり、このアプリの実装はonSendコールバック方式のため、送信予約専用に
// 送信先だけを渡す形にしている）。
export default function Composer({
  placeholder,
  onSend,
  mentionCandidates,
  scheduleTarget,
}: {
  placeholder: string
  onSend: (body: string, mentions: MentionPayload[]) => Promise<void>
  mentionCandidates?: MentionCandidate[]
  scheduleTarget?: ScheduleTarget
}) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [mentions, setMentions] = useState<MentionPayload[]>([])
  const [pickerQuery, setPickerQuery] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')
  const [scheduling, setScheduling] = useState(false)
  const toast = useToast()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const canSchedule = !!(scheduleTarget?.channel_id || scheduleTarget?.dm_id)

  // 3行目以降は入力に合わせて自動的に高さを広げ、10行を超えたらそれ以上は広げずスクロールにする
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const style = window.getComputedStyle(el)
    const lineHeight = parseFloat(style.lineHeight) || 20
    const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const minHeight = lineHeight * MIN_ROWS + paddingY
    const maxHeight = lineHeight * MAX_ROWS + paddingY

    el.style.height = 'auto'
    const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [body])

  const filteredCandidates = (mentionCandidates ?? []).filter((c) =>
    c.name.toLowerCase().includes((pickerQuery ?? '').toLowerCase()),
  )
  const pickerOpen = pickerQuery !== null && filteredCandidates.length > 0

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value
    setBody(text)
    if (!mentionCandidates) return
    const match = detectMentionQuery(text, e.target.selectionStart ?? text.length)
    setPickerQuery(match?.query ?? null)
    setActiveIndex(0)
  }

  const toggleSchedulePopover = () => {
    if (!scheduleOpen) {
      const d = defaultScheduleDateTime()
      setScheduleDate((prev) => prev || d.date)
      setScheduleTime((prev) => prev || d.time)
      setPickerQuery(null)
    }
    setScheduleOpen((v) => !v)
  }

  // 本文から削除されたメンションは除外する（選択後にテキストを手で消した場合の整合性維持。
  // 即時送信・送信予約のいずれも同じ基準で絞り込む）
  const activeMentionsIn = (text: string) => mentions.filter((m) => text.includes(`@${m.display_name_snapshot}`))

  const confirmSchedule = async () => {
    const text = body.trim()
    if (!text) {
      toast('本文を入力してください', 'error')
      return
    }
    if (!scheduleDate || !scheduleTime) {
      toast('送信日時を指定してください', 'error')
      return
    }
    const scheduledAt = new Date(`${scheduleDate}T${scheduleTime}:00`)
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
      toast('未来の日時を指定してください', 'error')
      return
    }
    setScheduling(true)
    try {
      await apiFetch('/api/scheduled-messages', {
        method: 'POST',
        body: JSON.stringify({
          ...scheduleTarget,
          body: text,
          mentions: activeMentionsIn(text),
          scheduled_at: scheduledAt.toISOString(),
        }),
      })
      setBody('')
      setMentions([])
      setScheduleOpen(false)
      toast('送信を予約しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '予約に失敗しました', 'error')
    } finally {
      setScheduling(false)
    }
  }

  const selectCandidate = (candidate: MentionCandidate) => {
    const el = textareaRef.current
    const cursor = el?.selectionStart ?? body.length
    const match = detectMentionQuery(body, cursor)
    if (!match) return
    const before = body.slice(0, match.atIndex)
    const after = body.slice(cursor)
    const insertText = `@${candidate.name} `
    setBody(before + insertText + after)
    setMentions((prev) => [...prev, { target_user_id: candidate.id, display_name_snapshot: candidate.name }])
    setPickerQuery(null)
    requestAnimationFrame(() => {
      const pos = before.length + insertText.length
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  // 入力欄下のメンションボタン（画面モックアップS-03のmention-btn）。カーソル位置に「@」を挿入し
  // ピッカーを開く。直前の文字が空白でない場合はdetectMentionQueryの開始条件を満たすよう半角空白を補う。
  const insertMentionTrigger = () => {
    const el = textareaRef.current
    const cursor = el?.selectionStart ?? body.length
    const before = body[cursor - 1]
    const insertText = cursor === 0 || before === undefined || /\s/.test(before) ? '@' : ' @'
    setBody(body.slice(0, cursor) + insertText + body.slice(cursor))
    setPickerQuery('')
    setActiveIndex(0)
    setScheduleOpen(false)
    requestAnimationFrame(() => {
      const pos = cursor + insertText.length
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  const send = async () => {
    const text = body.trim()
    if (!text) return
    setSending(true)
    try {
      await onSend(text, activeMentionsIn(text))
      setBody('')
      setMentions([])
    } catch (e) {
      toast(e instanceof Error ? e.message : '送信に失敗しました', 'error')
    } finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % filteredCandidates.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + filteredCandidates.length) % filteredCandidates.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectCandidate(filteredCandidates[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        setPickerQuery(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="relative rounded-[10px] border border-line-strong px-3 py-2.5">
      {pickerOpen && (
        <div className="absolute bottom-full left-0 z-40 mb-2 max-h-[260px] w-[300px] overflow-y-auto rounded-xl border border-line-strong bg-surface p-1.5 shadow-[0_12px_30px_rgba(16,24,40,0.18)]">
          {filteredCandidates.map((c, i) => (
            <button
              key={c.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                selectCandidate(c)
              }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${
                i === activeIndex ? 'bg-surface-subtle' : 'hover:bg-surface-subtle'
              }`}
            >
              <span
                className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-bold text-white"
                style={{ background: avatarColorFor(c.id) }}
              >
                {c.name.slice(0, 1)}
              </span>
              <span className="truncate text-[12.5px] font-bold text-ink">{c.name}</span>
            </button>
          ))}
        </div>
      )}
      {scheduleOpen && (
        <div className="absolute bottom-full right-0 z-40 mb-2 w-[260px] rounded-xl border border-line-strong bg-surface p-3 shadow-[0_12px_30px_rgba(16,24,40,0.18)]">
          <div className="mb-2 text-[12.5px] font-bold text-ink">送信日時を指定</div>
          <div className="flex gap-1.5">
            <input
              type="date"
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.target.value)}
              className="w-1/2 rounded-md border border-line-strong px-2 py-1.5 text-[12px] text-ink outline-none"
            />
            <input
              type="time"
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
              className="w-1/2 rounded-md border border-line-strong px-2 py-1.5 text-[12px] text-ink outline-none"
            />
          </div>
          <div className="mt-2 text-[11px] leading-relaxed text-ink-subtle">
            指定した日時に自動的に送信されます。送信されるまでは自分だけが内容を確認・キャンセルできます。
          </div>
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setScheduleOpen(false)}
              className="rounded-md border border-line-strong px-2.5 py-1 text-[11.5px] text-ink-muted"
            >
              キャンセル
            </button>
            <button
              type="button"
              disabled={scheduling}
              onClick={confirmSchedule}
              className="rounded-md bg-accent-600 px-2.5 py-1 text-[11.5px] font-bold text-white disabled:opacity-40"
            >
              予約する
            </button>
          </div>
        </div>
      )}
      <textarea
        ref={textareaRef}
        value={body}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={MIN_ROWS}
        maxLength={4000}
        className="w-full resize-none border-none text-[13px] text-ink outline-none placeholder:text-ink-subtle"
      />
      <div className="mt-2 flex items-center gap-0.5">
        {mentionCandidates && (
          <button
            type="button"
            title="メンション候補を表示"
            onClick={insertMentionTrigger}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-muted"
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M13 10a3 3 0 1 1-1-2.2M13 10v1.3a1.7 1.7 0 0 0 3.4 0V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {canSchedule && (
          <button
            type="button"
            title="送信日時を指定"
            onClick={toggleSchedulePopover}
            className={`ml-auto flex h-7 w-7 items-center justify-center rounded-md ${
              scheduleOpen ? 'bg-accent-50 text-accent-700' : 'text-ink-subtle hover:bg-surface-muted'
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10 6v4l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <button
          type="button"
          disabled={sending || !body.trim()}
          onClick={send}
          className={`rounded-[7px] bg-accent-600 px-4 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-40 ${
            canSchedule ? '' : 'ml-auto'
          }`}
        >
          送信
        </button>
      </div>
    </div>
  )
}
