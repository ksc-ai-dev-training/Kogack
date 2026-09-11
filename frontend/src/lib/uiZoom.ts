// UI全体の表示倍率（ブラウザのズームと同じ視覚拡大）。フォントサイズがpx直書き（約435箇所）で
// remベース化できないため、`document.documentElement`の`zoom`プロパティで一括拡大する方式にした
// （ユーザーからの要望「設定画面で文字の大きさを変えたい」への対応、案A＝UI全体ズーム）。
// 選択値はlocalStorageに保存する（スレッド幅・通知モードと同じ、サーバー同期不要の個人設定）。
//
// 注意: このロジックのミニ版が frontend/index.html の <head> インラインスクリプトにも複製されている
// （Reactマウント前に適用して初回描画のちらつきを防ぐため）。ズーム段階を増減するときは両方直すこと。

export type UiZoom = 'small' | 'normal' | 'large' | 'xlarge'

export const UI_ZOOM_STORAGE_KEY = 'kogack_ui_zoom'

export const UI_ZOOM_ORDER: UiZoom[] = ['small', 'normal', 'large', 'xlarge']

export const UI_ZOOM_SCALES: Record<UiZoom, number> = {
  small: 0.9,
  normal: 1,
  large: 1.1,
  xlarge: 1.25,
}

export const UI_ZOOM_LABELS: Record<UiZoom, string> = {
  small: '小',
  normal: '標準',
  large: '大',
  xlarge: '特大',
}

export function readUiZoom(): UiZoom {
  try {
    const v = localStorage.getItem(UI_ZOOM_STORAGE_KEY)
    if (v === 'small' || v === 'large' || v === 'xlarge') return v
  } catch {
    // プライベートブラウジング等でlocalStorageが読めなくても既定値で動く
  }
  return 'normal'
}

export function applyUiZoom(zoom: UiZoom): void {
  const scale = UI_ZOOM_SCALES[zoom] ?? 1
  const el = document.documentElement
  // Layout/Login の全画面高さ（100vh）を zoom で割り戻して縦スクロールを防ぐために CSS からも参照する
  el.style.setProperty('--ui-zoom', String(scale))
  // scale=1 のときは zoom 指定自体を外す（既定挙動に完全に戻す）
  el.style.zoom = scale === 1 ? '' : String(scale)
}
