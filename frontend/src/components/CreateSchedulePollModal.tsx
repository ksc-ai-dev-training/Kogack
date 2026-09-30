import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError } from '../lib/api'
import { useOverlayClose } from '../hooks/useOverlayClose'
import { useToast } from './Toast'

// 日程調整（ユーザーからの明示的な要望「作成者が日にちや時間をいくつか提示し、回答者が○△×で
// 回答して都合がいい人が最も多い日程を決める機能」、2026-09-30）の作成画面。当初は日付＋任意の
// 開始・終了時刻を選べたが、利用者の判断で同日中に日付のみへ変更した（時刻を伝えたい場合は
// タイトルに書く）。CreatePollModal.tsxと同じ構成（createPortal・useOverlayClose）。候補の
// 並び順はサーバーが日付順に整えるため、ここでは入力順のまま送る。
const MAX_OPTIONS = 30

function toDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const WEEKDAYS = '日月火水木金土'

/** 日付欄の横に出す曜日（ブラウザ標準の日付欄は曜日を表示しないため）。未入力ならnull */
function weekdayIndex(value: string): number | null {
  if (!value) return null
  const d = new Date(`${value}T00:00:00`)
  return Number.isNaN(d.getTime()) ? null : d.getDay()
}

/** 土日だけ色を変える（カレンダーの慣習どおり日曜=赤・土曜=青） */
function weekdayColor(day: number | null): string {
  if (day === 0) return 'text-danger-text'
  if (day === 6) return 'text-accent-600'
  return 'text-ink-muted'
}

/** 「＋ 候補を追加」で足す行の初期値。直前の行の翌日にする（連続した日を候補に並べることが
 * 多いため、毎回日付を選び直さずに済むように） */
function nextDate(prev: string | undefined): string {
  if (!prev) return ''
  const d = new Date(`${prev}T00:00:00`)
  d.setDate(d.getDate() + 1)
  return toDateInput(d)
}

export function CreateSchedulePollModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (title: string, dates: string[]) => Promise<void>
}) {
  const overlayClose = useOverlayClose(onClose)
  const toast = useToast()
  const [title, setTitle] = useState('')
  const [dates, setDates] = useState<string[]>([''])
  const [saving, setSaving] = useState(false)

  const updateDate = (i: number, value: string) => {
    setDates((prev) => prev.map((d, idx) => (idx === i ? value : d)))
  }
  const addDate = () => {
    if (dates.length >= MAX_OPTIONS) return
    setDates((prev) => [...prev, nextDate(prev[prev.length - 1])])
  }
  const removeDate = (i: number) => {
    if (dates.length <= 1) return
    setDates((prev) => prev.filter((_, idx) => idx !== i))
  }

  const submit = async () => {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) {
      toast('タイトルを入力してください', 'error')
      return
    }
    const filled = dates.filter((d) => d)
    if (filled.length === 0) {
      toast('候補日を1件以上入力してください', 'error')
      return
    }
    if (new Set(filled).size !== filled.length) {
      toast('同じ候補日が重複しています', 'error')
      return
    }
    setSaving(true)
    try {
      await onCreate(trimmedTitle, filled)
      onClose()
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '日程調整の作成に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  const inputCls =
    'rounded-md border border-line-strong px-2 py-1.5 text-[13px] text-ink outline-none focus:border-accent-600'

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(20,24,33,0.5)] p-6" {...overlayClose}>
      <div
        className="max-h-[85vh] w-full max-w-[420px] overflow-y-auto rounded-[14px] bg-surface p-4 shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[14px] font-bold text-ink">日程調整を作成</div>

        <label className="mb-1 block text-[11.5px] font-semibold text-ink-muted">タイトル</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例: 10月の定例ミーティング（14時〜）"
          maxLength={4000}
          className={`mb-3 w-full ${inputCls}`}
        />

        <label className="mb-1 block text-[11.5px] font-semibold text-ink-muted">
          候補日（最大{MAX_OPTIONS}件）
        </label>
        <div className="mb-2 flex flex-col gap-1.5">
          {dates.map((d, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                type="date"
                value={d}
                onChange={(e) => updateDate(i, e.target.value)}
                aria-label={`候補 ${i + 1} の日付`}
                className={`min-w-0 flex-1 ${inputCls}`}
              />
              <span className={`w-7 flex-none text-center text-[13px] ${weekdayColor(weekdayIndex(d))}`}>
                {weekdayIndex(d) !== null ? `(${WEEKDAYS[weekdayIndex(d)!]})` : ''}
              </span>
              <button
                type="button"
                onClick={() => removeDate(i)}
                disabled={dates.length <= 1}
                title="この候補を削除"
                className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-ink-subtle hover:bg-surface-subtle disabled:opacity-30"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addDate}
          disabled={dates.length >= MAX_OPTIONS}
          className="mb-4 rounded-md border border-line-strong px-2.5 py-1 text-[12px] font-semibold text-ink-muted hover:bg-surface-subtle disabled:opacity-30"
        >
          ＋ 候補を追加
        </button>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line-strong px-3 py-1.5 text-[12.5px] text-ink-muted hover:bg-surface-subtle"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="rounded-md bg-accent-600 px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-40"
          >
            {saving ? '作成中…' : '作成する'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
