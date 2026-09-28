// サイドバーの「チャンネル」「ダイレクトメッセージ」見出しの開閉状態（ユーザーからの相談「参加
// しているチャンネルが多くなったらサイドバーの表示はどうなるのか。チャンネル表示を閉じるボタンとか
// も必要か」に対し、Slackと同じ見出しでの開閉を提案して採用、2026-09-28）。件数の上限で一律に
// 切ると上限より後ろのチャンネルの未読・メンションが見えなくなるため採らず、閉じている間も未読・
// メンションのあるものと今開いているものは表示し続ける（Layout.tsx）。
// サーバー同期不要の個人のUI設定のため、localStorageが使えない環境では常に開いた状態になる。
const SIDEBAR_SECTIONS_STORAGE_KEY = 'kogack-sidebar-collapsed'

export interface SidebarCollapsed {
  channels: boolean
  dms: boolean
}

export function readSidebarCollapsed(): SidebarCollapsed {
  try {
    const parsed = JSON.parse(localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY) ?? '{}')
    return { channels: parsed.channels === true, dms: parsed.dms === true }
  } catch {
    return { channels: false, dms: false }
  }
}

export function saveSidebarCollapsed(value: SidebarCollapsed): void {
  try {
    localStorage.setItem(SIDEBAR_SECTIONS_STORAGE_KEY, JSON.stringify(value))
  } catch {
    // noop（プライベートブラウジング等でlocalStorageが使えない場合）
  }
}
