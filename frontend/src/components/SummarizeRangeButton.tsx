import { useEffect, useRef, useState } from 'react'

export type SummaryRange = { since?: string; until?: string }

function toIsoDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function rangeFromToday(daysBack: number): SummaryRange {
  const until = new Date()
  const since = new Date()
  since.setDate(since.getDate() - daysBack)
  return { since: toIsoDate(since), until: toIsoDate(until) }
}

function rangeFromWeekStart(): SummaryRange {
  const until = new Date()
  const since = new Date()
  const day = (since.getDay() + 6) % 7 // 月曜=0起点に変換
  since.setDate(since.getDate() - day)
  return { since: toIsoDate(since), until: toIsoDate(until) }
}

function rangeFromMonthStart(): SummaryRange {
  const until = new Date()
  const since = new Date(until.getFullYear(), until.getMonth(), 1)
  return { since: toIsoDate(since), until: toIsoDate(until) }
}

const PRESETS: { label: string; range: () => SummaryRange }[] = [
  { label: '今日', range: () => rangeFromToday(0) },
  { label: '今週', range: () => rangeFromWeekStart() },
  { label: '今月', range: () => rangeFromMonthStart() },
  { label: '直近7日間', range: () => rangeFromToday(6) },
  { label: '直近30日間', range: () => rangeFromToday(29) },
]

// A-15要約ボタンに対象期間を指定できる機能を追加した（ユーザーからの明示的な要望「要約ボタンでも
// 範囲を決められるようにしたい」、2026-09-14。チャット上の「今月分の要約して」「直近10日間分の
// 要約して」と対になる機能）。既存の単発クリック＝即時要約という挙動を壊さないよう、主ボタンは
// そのまま（範囲指定なしで即実行）にし、隣の▾ボタンでポップオーバーを開いて期間を選べる
// 「split button」構成にした（メンション🕐送信予約ポップオーバーと同じ「追加の選択肢」という位置づけ）。
export default function SummarizeRangeButton({
  summarizing,
  onSummarize,
  mainButtonTitle,
  size = 'header',
}: {
  summarizing: boolean
  onSummarize: (range?: SummaryRange) => void
  mainButtonTitle: string
  size?: 'header' | 'thread'
}) {
  const [open, setOpen] = useState(false)
  const [customSince, setCustomSince] = useState('')
  const [customUntil, setCustomUntil] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const runPreset = (range: SummaryRange) => {
    setOpen(false)
    onSummarize(range)
  }

  const runCustom = () => {
    if (!customSince && !customUntil) return
    setOpen(false)
    onSummarize({ since: customSince || undefined, until: customUntil || undefined })
    setCustomSince('')
    setCustomUntil('')
  }

  const isThread = size === 'thread'
  const mainClass = `flex-none rounded-l-[7px] border border-accent-100 bg-accent-50 font-semibold text-accent-700 hover:bg-accent-100 disabled:opacity-50 ${
    isThread ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1 text-xs'
  }`
  const chevronClass = `flex-none rounded-r-[7px] border border-l-0 border-accent-100 bg-accent-50 text-accent-700 hover:bg-accent-100 disabled:opacity-50 ${
    isThread ? 'px-1 py-1 text-[10px]' : 'px-1.5 py-1 text-[10px]'
  }`

  return (
    <div ref={wrapRef} className="relative flex flex-none items-stretch">
      <button type="button" disabled={summarizing} onClick={() => onSummarize()} title={mainButtonTitle} className={mainClass}>
        📝 {summarizing ? '要約中...' : '要約'}
      </button>
      <button
        type="button"
        disabled={summarizing}
        onClick={() => setOpen((v) => !v)}
        title="対象期間を指定して要約"
        className={chevronClass}
      >
        ▾
      </button>

      {open && (
        <div className="absolute right-0 top-full z-30 mt-1.5 w-[240px] rounded-lg border border-line bg-surface p-2 text-[12px] shadow-lg">
          <div className="mb-1.5 px-1 font-bold text-ink">対象期間を指定して要約</div>
          <div className="mb-1.5 flex flex-wrap gap-1 px-1">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => runPreset(p.range())}
                className="rounded-md border border-line px-2 py-1 text-[11px] font-semibold text-ink-muted hover:border-line-strong hover:bg-surface-subtle"
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="border-t border-line px-1 pt-1.5">
            <div className="mb-1 text-[11px] font-semibold text-ink-subtle">期間を指定</div>
            <div className="flex items-center gap-1">
              <input
                type="date"
                value={customSince}
                onChange={(e) => setCustomSince(e.target.value)}
                className="w-0 flex-1 rounded border border-line px-1 py-0.5 text-[11px]"
              />
              <span className="text-ink-subtle">〜</span>
              <input
                type="date"
                value={customUntil}
                onChange={(e) => setCustomUntil(e.target.value)}
                className="w-0 flex-1 rounded border border-line px-1 py-0.5 text-[11px]"
              />
            </div>
            <button
              type="button"
              disabled={!customSince && !customUntil}
              onClick={runCustom}
              className="mt-1.5 w-full rounded-md bg-accent-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-accent-700 disabled:opacity-40"
            >
              この期間で要約する
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
