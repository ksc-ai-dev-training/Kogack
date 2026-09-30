import { useState, type MouseEvent } from 'react'

// 発言のアクションバー（リアクション・返信・編集・削除）をタップで出すための状態（F-32 モバイル
// 対応レイアウト、2026-09-30）。アクションバーはgroup-hover:flexで出しているが、Tailwind 4の
// hover系バリアントは@media (hover: hover)の中にしか出力されないため、スマホ等のタッチ端末では
// 一切表示されず、返信・リアクションができなかった。ホバーできない端末に限り、発言の空白部分を
// タップするとその発言のバーを出し、もう一度タップ（または別の発言をタップ）で切り替える。
// リンク・ボタン・入力欄など、それ自体に操作がある要素のタップはそちらを優先して無視する
export function useTapToShowActions() {
  const [tappedId, setTappedId] = useState<string | null>(null)
  const onRowClick = (id: string, e: MouseEvent<HTMLElement>) => {
    if (!window.matchMedia('(hover: none)').matches) return
    if ((e.target as HTMLElement).closest('a, button, input, textarea, select, label, [contenteditable="true"]')) return
    setTappedId((v) => (v === id ? null : id))
  }
  // アクションバーのclassName（ホバー時に加え、タップで選んだ発言は常に表示）
  const barVisibility = (id: string) => (tappedId === id ? 'flex' : 'hidden group-hover:flex')
  return { onRowClick, barVisibility }
}
