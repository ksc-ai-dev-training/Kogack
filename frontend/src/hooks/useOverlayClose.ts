import { useRef } from 'react'

// モーダルの背景（オーバーレイ）をクリックしたら閉じる、を安全に実装する共通hook。
// バグ修正（2026-09-04）: 従来は各モーダルでオーバーレイに`onClick={onClose}`、モーダル本体に
// `onClick={e => e.stopPropagation()}`を付けるだけの実装だったが、モーダル内のテキストを
// ドラッグして選択し、マウスをオーバーレイ側（モーダルの外）で離すと誤って閉じてしまう不具合が
// あった（ユーザーからの報告）。ドラッグの開始位置（mousedown）と終了位置（mouseup／click）が
// 異なる要素にまたがる場合、ブラウザのclickイベントは両者の共通の祖先要素＝オーバーレイ自身で
// 発火するため、モーダル本体側のstopPropagationでは防げない。mousedownの開始位置も
// オーバーレイ自身であることを追加で要求することで、ドラッグ操作によるクリック判定を除外する
// （通常の「モーダル内をクリックする」操作は、そのクリックがオーバーレイまでバブリングしても
// e.targetがオーバーレイ自身にはならないため、従来どおり閉じない）
export function useOverlayClose(onClose: () => void) {
  const mouseDownOnSelf = useRef(false)
  return {
    onMouseDown: (e: React.MouseEvent<HTMLElement>) => {
      mouseDownOnSelf.current = e.target === e.currentTarget
    },
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      if (mouseDownOnSelf.current && e.target === e.currentTarget) onClose()
    },
  }
}
