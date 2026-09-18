import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError } from '../lib/api'
import { useOverlayClose } from '../hooks/useOverlayClose'
import { useToast } from './Toast'

// アンケート機能（ユーザーからの明示的な要望「チャットアプリに新しくアンケート機能を付けて
// ほしい」、2026-09-18）。着手前にAskUserQuestionで4点確認し、(1)作成方法=投稿欄のボタンから、
// (2)投票方式=単一選択のみ（選択肢を複数選べるトグルは無い）、(3)投票の可視性=誰が何に投票
// したか見える（既存の絵文字リアクションと同じ考え方）、(4)作成権限=参加者なら誰でも、という
// 仕様で合意した。AddCustomEmojiModal.tsxと同じ構成（createPortal・useOverlayClose）。
const MIN_OPTIONS = 2
const MAX_OPTIONS = 10

export function CreatePollModal({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (question: string, options: string[]) => Promise<void>
}) {
  const overlayClose = useOverlayClose(onClose)
  const toast = useToast()
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<string[]>(['', ''])
  const [saving, setSaving] = useState(false)

  const updateOption = (i: number, value: string) => {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? value : o)))
  }
  const addOption = () => {
    if (options.length >= MAX_OPTIONS) return
    setOptions((prev) => [...prev, ''])
  }
  const removeOption = (i: number) => {
    if (options.length <= MIN_OPTIONS) return
    setOptions((prev) => prev.filter((_, idx) => idx !== i))
  }

  const submit = async () => {
    const trimmedQuestion = question.trim()
    if (!trimmedQuestion) {
      toast('質問を入力してください', 'error')
      return
    }
    const trimmedOptions = options.map((o) => o.trim()).filter((o) => o.length > 0)
    if (trimmedOptions.length < MIN_OPTIONS) {
      toast(`選択肢を${MIN_OPTIONS}件以上入力してください`, 'error')
      return
    }
    setSaving(true)
    try {
      await onCreate(trimmedQuestion, trimmedOptions)
      onClose()
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'アンケートの作成に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(20,24,33,0.5)] p-6" {...overlayClose}>
      <div
        className="max-h-[85vh] w-full max-w-[420px] overflow-y-auto rounded-[14px] bg-surface p-4 shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[14px] font-bold text-ink">アンケートを作成</div>

        <label className="mb-1 block text-[11.5px] font-semibold text-ink-muted">質問</label>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="例: 次回の懇親会はいつがいいですか？"
          maxLength={4000}
          className="mb-3 w-full rounded-md border border-line-strong px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent-600"
        />

        <label className="mb-1 block text-[11.5px] font-semibold text-ink-muted">
          選択肢（{MIN_OPTIONS}〜{MAX_OPTIONS}件）
        </label>
        <div className="mb-2 flex flex-col gap-1.5">
          {options.map((opt, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={opt}
                onChange={(e) => updateOption(i, e.target.value)}
                placeholder={`選択肢 ${i + 1}`}
                maxLength={100}
                className="flex-1 rounded-md border border-line-strong px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent-600"
              />
              <button
                type="button"
                onClick={() => removeOption(i)}
                disabled={options.length <= MIN_OPTIONS}
                title="この選択肢を削除"
                className="flex h-7 w-7 flex-none items-center justify-center rounded-md text-ink-subtle hover:bg-surface-subtle disabled:opacity-30"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addOption}
          disabled={options.length >= MAX_OPTIONS}
          className="mb-4 rounded-md border border-line-strong px-2.5 py-1 text-[12px] font-semibold text-ink-muted hover:bg-surface-subtle disabled:opacity-30"
        >
          ＋ 選択肢を追加
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
