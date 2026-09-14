import { useEffect } from 'react'
import type { Channel, Dm } from '../types'

// ブラウザのタブタイトルに未読件数を表示する（ユーザーからの明示的な要望「通知が来たときに、
// ブラウザのタイトル部分でも新着メッセージが分かるようにしてほしい」）。デスクトップ通知①
// （useDesktopNotifications.ts）とは独立した仕組みにした: 通知は「新着の増分」を検知した瞬間
// だけ一度出すイベント的な性質だが、タブタイトルは「今どれだけ未読が溜まっているか」を常時
// アンビエントに示すものなので、通知の許可（Notification.permission）やタブの可視状態には
// 依存させず、常にjoined/dmsのunread_countの合計をそのまま反映する（サイドバーの未読バッジの
// 合計と常に一致させる）。unread_mention_count（メンション・スレッド活動）はチャンネルでは
// unread_countの部分集合、DMでは完全に別集合（2026-09-14のスレッド内通知追加でスレッド限定に
// なった）と挙動が統一されていないため、二重計上を避けてunread_countのみを合計する
export function useUnreadTitleBadge(joined: Channel[], dms: Dm[]) {
  useEffect(() => {
    const baseTitle = document.title.replace(/^\(\d+\+?\) /, '')
    const total =
      joined.reduce((sum, c) => sum + (c.unread_count ?? 0), 0) +
      dms.reduce((sum, d) => sum + (d.unread_count ?? 0), 0)
    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) ${baseTitle}` : baseTitle
  }, [joined, dms])
}
