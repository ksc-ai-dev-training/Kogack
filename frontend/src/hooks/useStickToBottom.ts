import { useCallback, useRef, type RefObject } from 'react'

// 一番下（最新の発言）を見ている間は、一覧の中身の高さが変わっても一番下に留まり続ける
// （ユーザーからの報告「最新から二番目の発言にリアクションしたら、最新のやつがその分下に
// 下がって、最新のメッセージがメッセージ入力欄に一部隠れて見えなくなった」、2026-09-28）。
// 各画面の「最後の発言のupdated_atが変わったら末尾へスクロール」は新着・最後の発言の更新にしか
// 反応せず、途中の発言へのリアクション・投票・画像の読み込み完了・入力欄の高さの変化のように
// 最後の発言以外で高さが変わった場合は、スクロール位置が据え置かれて最新の発言が押し出されていた。
// スクロールコンテナ自身と、その直下の子要素（=中身）の大きさの変化をResizeObserverで監視し、
// 変化の直前に一番下にいた場合だけ一番下へ戻す。さかのぼって読んでいる最中（一番下にいない）は
// 何もしないため、読んでいる位置を勝手に動かさない。
//
// 戻り値はスクロールコンテナに渡すコールバックref（渡したrefObjectにも同じ要素を入れる）。
// 各画面はエラー表示等で一覧より先に早期returnすることがあり、一覧の要素が初回描画の後から
// 現れるため、useEffectではなく要素が実際に付いた・外れたタイミングで監視を付け外しする。
//
// enabled=falseの間は一番下へ戻さない。検索結果からのハイライトジャンプ（MessageListの
// scrollIntoView、smooth）の最中に使う——アニメーション中に中身の大きさが変わると、まだ
// 「一番下にいる」と判定されて末尾へ引き戻され、目的の発言へ移動できなくなるため（各画面の
// 末尾自動スクロールがハイライト中は止まるのと同じ条件を渡す）。
const BOTTOM_THRESHOLD_PX = 40

export function useStickToBottom<T extends HTMLElement>(ref: RefObject<T | null>, enabled = true) {
  const cleanupRef = useRef<(() => void) | null>(null)
  // コールバックrefを作り直すと監視も付け直しになるため、最新の値はrefで参照する
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  return useCallback(
    (el: T | null) => {
      ref.current = el
      cleanupRef.current?.()
      cleanupRef.current = null
      if (!el) return
      let atBottom = true
      const measure = () => {
        atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX
      }
      const resizeObserver = new ResizeObserver(() => {
        if (atBottom && enabledRef.current) el.scrollTop = el.scrollHeight
        measure()
      })
      const observeChildren = () => {
        resizeObserver.disconnect()
        resizeObserver.observe(el)
        for (const child of Array.from(el.children)) resizeObserver.observe(child)
      }
      // 「もっと古いメッセージを読み込む」ボタンの出し入れ等で直下の子要素が入れ替わったら監視し直す
      const mutationObserver = new MutationObserver(observeChildren)
      observeChildren()
      mutationObserver.observe(el, { childList: true })
      el.addEventListener('scroll', measure, { passive: true })
      cleanupRef.current = () => {
        resizeObserver.disconnect()
        mutationObserver.disconnect()
        el.removeEventListener('scroll', measure)
      }
    },
    [ref],
  )
}
