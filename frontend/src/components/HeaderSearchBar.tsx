import { useNavigate } from 'react-router'
import { useUnsavedChangesGuard } from '../lib/unsavedChanges'

// S-03ヘッダーのチャンネルタイトル右側に置く常時表示の検索欄（ユーザーからの明示的な要望
// 「検索バーの機能は完璧なので、場所をサイドバーじゃなくて、ヘッダーのチャンネルタイトルが
// 書いてある右側においてほしい」。2026-09-15にサイドバー上部へ実装したもの（当時の設計判断
// はCLAUDE.md参照）から移設し、コンポーネント自体はそのまま流用した）。フォーカスした瞬間に
// 実際の検索ページ（S-05 SearchView.tsx）へ遷移する設計・遷移先URLへのin/in_label付与・
// SearchView.tsx側の既存の状態復元ロジックをそのまま使う点は移設前と変わらない
export default function HeaderSearchBar({
  currentChannelName, currentChannelId,
}: {
  currentChannelName?: string
  currentChannelId?: string
}) {
  const navigate = useNavigate()
  const guardNavigation = useUnsavedChangesGuard()

  const openSearch = async (e: React.FocusEvent<HTMLInputElement> | React.MouseEvent<HTMLInputElement>) => {
    e.currentTarget.blur()
    if (!(await guardNavigation())) return
    const params = new URLSearchParams()
    if (currentChannelId && currentChannelName) {
      params.set('in', currentChannelId)
      params.set('in_label', currentChannelName)
    }
    const qs = params.toString()
    navigate(qs ? `/search?${qs}` : '/search')
  }

  return (
    <div className="relative w-56 flex-none">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] text-ink-subtle">
        🔍
      </span>
      <input
        type="text"
        readOnly
        onFocus={openSearch}
        onClick={openSearch}
        placeholder={currentChannelName ? `#${currentChannelName} を検索` : '検索'}
        title="横断検索"
        className="w-full cursor-pointer rounded-md border border-line-strong bg-surface-subtle py-1 pl-7 pr-2.5 text-[12px] text-ink-muted outline-none placeholder:text-ink-subtle hover:border-accent-600 focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
      />
    </div>
  )
}
