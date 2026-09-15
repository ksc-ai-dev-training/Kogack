import { useNavigate } from 'react-router'
import { useUnsavedChangesGuard } from '../lib/unsavedChanges'

// S-03ヘッダーのチャンネルタイトル右側に置く常時表示の検索欄（ユーザーからの明示的な要望
// 「検索バーの機能は完璧なので、場所をサイドバーじゃなくて、ヘッダーのチャンネルタイトルが
// 書いてある右側においてほしい」。2026-09-15にサイドバー上部へ実装したもの（当時の設計判断
// はCLAUDE.md参照）から移設し、コンポーネント自体はそのまま流用した）。フォーカスした瞬間に
// 実際の検索ページ（S-05 SearchView.tsx）へ遷移する設計・遷移先URLへのin/in_label付与・
// SearchView.tsx側の既存の状態復元ロジックをそのまま使う点は移設前と変わらない。
// 外側divにml-autoを持たせ、チャンネル名・説明文（いずれも可変長）に押し出されず常に
// ヘッダー右側の固定位置（所属メンバー等のボタン群の直前）に来るようにしている（ユーザーからの
// 報告「チャンネル名の長さやチャンネル説明文の有無で検索バーの位置が変わるのが見づらい」への
// 対応、2026-09-15）
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
    <div className="relative ml-auto w-56 flex-none">
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
