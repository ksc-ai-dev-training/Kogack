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

// 現在適用中のズーム倍率を読み取る（ユーザーからの報告「画面を最大化し文字サイズを大/特大に
// すると、発言の絵文字リアクション一覧ポップオーバーが画面外にはみ出す」の修正で追加）。
// `document.documentElement`に`zoom`スタイルを設定すると、その配下の全要素（document.bodyへ
// createPortalしたポップオーバーも含む）のCSS px指定は実際の画面上でzoom倍された大きさで
// 描画される（例: `width:240px`はzoom=1.25なら実際には300px相当で見える。getBoundingClientRect
// も同様に画面上の実サイズを返す）一方、window.innerWidth/innerHeightはズームに関わらず常に
// 実際のビューポートサイズを返す。EmojiGridPopover・ProfileCard等の「画面端でのはみ出し判定」は
// ポップオーバー自身の見積もりサイズ（px定数）をこのズーム倍率で補正しないと、実際の描画サイズを
// 過小評価し、大きな倍率で画面外にはみ出す。`--ui-zoom`はapplyUiZoomが常に（scale=1のときも）
// documentElementへ設定するCSSカスタムプロパティで、index.cssの`:root{--ui-zoom:1}`が既定値の
// フォールバックになっている
export function currentUiZoomScale(): number {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')
    const scale = parseFloat(raw)
    return Number.isFinite(scale) && scale > 0 ? scale : 1
  } catch {
    return 1
  }
}
