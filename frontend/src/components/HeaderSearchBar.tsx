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
// 対応、2026-09-15）。幅はw-56(224px)からw-64(256px)へ拡大した（ユーザーからの要望「検索バーの
// 長さをもっと長くしてほしい（チャンネル説明文に影響を与えない範囲で）」）。実測（サイドバー
// 260px＋実際のヘッダー構成を再現したPlaywright検証、`npm run build`で実際に生成されたCSSを
// 都度読み込んで検証——Tailwindは実際にソースで使われているクラスしかCSSへ出力しないため、
// テストHTML側だけでクラス名を差し替えても正しく検証できない点に注意）で、1366px以上の
// ウィンドウ幅（サイドバー260pxを除いた本文領域が約1100px以上）では説明文（max-w-[220px]）の
// 表示幅に一切影響が無いことを確認済み。1280px幅（本文領域1020px）というよくあるノートPC解像度
// でのみ説明文がわずかに縮む（220px→189px。既存のw-56でも213pxへ縮んでおり元から起きていた現象
// で、w-64はこれをわずかに悪化させる程度に留まる）。w-72(288px)以上に広げると同じ1280px幅で
// 220px→164pxまで縮み体感できる悪化になるため採用しなかった
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
    <div className="relative ml-auto w-64 flex-none">
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
