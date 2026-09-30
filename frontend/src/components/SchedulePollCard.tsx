import { useState } from 'react'
import { decideSchedulePoll, respondSchedulePoll } from '../lib/api'
import type { ScheduleAnswer, SchedulePoll } from '../types'
import { useConfirm } from './ui/ConfirmDialog'
import { useToast } from './Toast'

// 日程調整（polls.kind='schedule'・T-32、ユーザーからの明示的な要望、2026-09-30）のカード。
// 着手前にAskUserQuestionで合意した仕様: 回答は○△×の3段階、ひとことコメント付き、作成者
// （またはシステム管理者）が「決定」で確定するとスレッドへお知らせが投稿される。調整さん等と
// 同じく「候補×回答者」の一覧表で全員の回答を見せ、○が最多（同数なら△が多い）候補を強調する。
// PollCard（MessageList.tsx）と異なり回答・確定のAPI呼び出しをこのカード自身が持ち、更新後の
// payloadをonUpdatedで呼び出し元へ返す（S-03本体・S-04スレッド元発言の両方で同じ動きにするため）。

const MARKS: Record<ScheduleAnswer, string> = { yes: '○', maybe: '△', no: '×' }
const ANSWER_ORDER: ScheduleAnswer[] = ['yes', 'maybe', 'no']
const MARK_COLOR: Record<ScheduleAnswer, string> = {
  yes: 'text-ok-text',
  maybe: 'text-bot-text',
  no: 'text-ink-subtle',
}

export function SchedulePollCard({
  poll,
  title,
  currentUserId,
  canDecide,
  onUpdated,
}: {
  poll: SchedulePoll
  title: string
  currentUserId: string | undefined
  canDecide: boolean
  onUpdated?: (poll: SchedulePoll) => void
}) {
  const toast = useToast()
  const confirm = useConfirm()
  const closed = poll.closed_at !== null
  const mine = poll.respondents.find((r) => r.user_id === currentUserId)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, ScheduleAnswer>>({})
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [deciding, setDeciding] = useState(false)
  const best = new Set(poll.best_option_ids)
  const comments = poll.respondents.filter((r) => r.comment)

  const startEditing = () => {
    setDraft(mine ? { ...mine.answers } : {})
    setComment(mine?.comment ?? '')
    setEditing(true)
  }

  const save = async () => {
    if (poll.options.some((o) => !draft[o.id])) {
      toast('すべての候補日程に○△×のいずれかを選んでください', 'error')
      return
    }
    setSaving(true)
    try {
      onUpdated?.(await respondSchedulePoll(poll.id, draft, comment.trim()))
      setEditing(false)
    } catch (e) {
      toast(e instanceof Error ? e.message : '回答の保存に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  const decide = async (optionId: string, label: string) => {
    const ok = await confirm({
      title: '日程を決定',
      message: `「${label}」に決定しますか？\n決定すると回答の受け付けを終了し、スレッドに決定のお知らせを投稿します。決定は取り消せません。`,
      confirmLabel: '決定する',
    })
    if (!ok) return
    setDeciding(true)
    try {
      onUpdated?.(await decideSchedulePoll(poll.id, optionId))
    } catch (e) {
      toast(e instanceof Error ? e.message : '日程の決定に失敗しました', 'error')
    } finally {
      setDeciding(false)
    }
  }

  const decidedLabel = poll.options.find((o) => o.id === poll.decided_option_id)?.label

  return (
    <div className="mt-0.5 max-w-[640px] rounded-lg border border-line bg-surface p-3">
      <div className="text-[13.5px] font-semibold text-ink">📅 {title}</div>
      {decidedLabel && (
        <div className="mt-1.5 inline-block rounded-md bg-ok-bg px-2 py-0.5 text-[12px] font-semibold text-ok-text">
          {decidedLabel} に決定しました
        </div>
      )}

      {editing ? (
        <div className="mt-2">
          <div className="flex flex-col gap-1">
            {poll.options.map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-2">
                <span className="text-[12.5px] text-ink">{o.label}</span>
                <div className="flex flex-none gap-1" role="radiogroup" aria-label={o.label}>
                  {ANSWER_ORDER.map((a) => {
                    const selected = draft[o.id] === a
                    return (
                      <button
                        key={a}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setDraft((prev) => ({ ...prev, [o.id]: a }))}
                        className={`h-7 w-8 rounded-md border text-[14px] font-bold ${
                          selected
                            ? 'border-accent-600 bg-accent-100 text-accent-700'
                            : 'border-line-strong bg-surface text-ink-subtle hover:bg-surface-subtle'
                        }`}
                      >
                        {MARKS[a]}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="ひとことコメント（任意）例: △の日は30分遅れます"
            maxLength={200}
            className="mt-2 w-full rounded-md border border-line-strong px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent-600"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-md border border-line-strong px-3 py-1 text-[12px] text-ink-muted hover:bg-surface-subtle"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded-md bg-accent-600 px-3 py-1 text-[12px] font-semibold text-white disabled:opacity-40"
            >
              {saving ? '保存中…' : '回答を保存'}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="border-collapse text-[12.5px]">
            <thead>
              <tr className="text-[11px] text-ink-subtle">
                <th className="px-1.5 py-1 text-left font-semibold">候補日</th>
                {ANSWER_ORDER.map((a) => (
                  <th key={a} className="w-7 px-1 py-1 text-center font-semibold">{MARKS[a]}</th>
                ))}
                {poll.respondents.map((r) => (
                  <th
                    key={r.user_id}
                    title={r.user_name}
                    className="max-w-[64px] truncate border-l border-line px-1.5 py-1 text-center font-semibold"
                  >
                    {r.user_name}
                  </th>
                ))}
                {canDecide && !closed && <th />}
              </tr>
            </thead>
            <tbody>
              {poll.options.map((o) => {
                const decided = o.id === poll.decided_option_id
                const highlight = decided || (!poll.decided_option_id && best.has(o.id))
                return (
                  <tr
                    key={o.id}
                    className={`border-t border-line ${decided ? 'bg-ok-bg' : highlight ? 'bg-accent-50' : ''}`}
                  >
                    <td className="whitespace-nowrap px-1.5 py-1 text-ink">
                      {decided ? '✓ ' : highlight ? '★ ' : ''}
                      {o.label}
                    </td>
                    <td className="px-1 py-1 text-center font-semibold text-ink">{o.yes_count}</td>
                    <td className="px-1 py-1 text-center text-ink-muted">{o.maybe_count}</td>
                    <td className="px-1 py-1 text-center text-ink-muted">{o.no_count}</td>
                    {poll.respondents.map((r) => {
                      const a = r.answers[o.id]
                      return (
                        <td
                          key={r.user_id}
                          className={`border-l border-line px-1.5 py-1 text-center font-bold ${a ? MARK_COLOR[a] : ''}`}
                        >
                          {a ? MARKS[a] : '-'}
                        </td>
                      )
                    })}
                    {canDecide && !closed && (
                      <td className="px-1.5 py-1 text-right">
                        <button
                          type="button"
                          disabled={deciding}
                          onClick={() => decide(o.id, o.label)}
                          className="whitespace-nowrap rounded border border-line-strong px-1.5 py-0.5 text-[11px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-600 disabled:opacity-50"
                        >
                          決定
                        </button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!editing && comments.length > 0 && (
        <div className="mt-2 flex flex-col gap-0.5 text-[12px] text-ink-muted">
          {comments.map((r) => (
            <div key={r.user_id} className="break-words">
              💬 <span className="font-semibold">{r.user_name}</span>: {r.comment}
            </div>
          ))}
        </div>
      )}

      {!editing && (
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-ink-subtle">
          <span>
            回答者{poll.total_votes}人
            {closed ? (poll.decided_option_id ? '・決定済み' : '・締め切り済み') : ''}
          </span>
          {!closed && (
            <button
              type="button"
              onClick={startEditing}
              className="rounded-md bg-accent-600 px-2.5 py-1 text-[12px] font-semibold text-white"
            >
              {mine ? '回答を修正する' : '回答する'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
