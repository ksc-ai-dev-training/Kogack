import { useCallback, useState } from 'react'
import { applyUiZoom, readUiZoom, UI_ZOOM_STORAGE_KEY, type UiZoom } from '../lib/uiZoom'

// UI全体の表示倍率（案A）の状態＋切替。初回適用は frontend/index.html のインラインスクリプトが
// 済ませているため、ここでは現在値の読み出しと、切替時の保存＋再適用だけを行う。
export function useUiZoom() {
  const [zoom, setZoomState] = useState<UiZoom>(readUiZoom)

  const setZoom = useCallback((next: UiZoom) => {
    setZoomState(next)
    try {
      localStorage.setItem(UI_ZOOM_STORAGE_KEY, next)
    } catch {
      // 保存できなくてもこのセッション中は効く
    }
    applyUiZoom(next)
  }, [])

  return { zoom, setZoom }
}
