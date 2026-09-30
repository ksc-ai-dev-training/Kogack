import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { useUnsavedChangesGuard } from '../lib/unsavedChanges'

// スマホ表示（F-32）の会話・設定画面ヘッダーに置く「戻る」リンク。スマホではサイドバーと
// 会話を別画面に分けている（Layout.tsx参照）ため、サイドバー側の画面へ戻る唯一の導線になる。
// PC表示では常にサイドバーが見えているので出さない（md:hidden）。childrenを省略すると
// ヘッダー左端用の「‹」アイコンボタンになり、渡すとその文字列のテキストリンクになる。
// GuardedLinkはパスが同じなら（?tab=の違いだけなら）遷移しない作りで、「/admin?tab=users →
// /admin（項目一覧）」へ戻れないため使わず、未保存の変更ガードだけを同じように挟む
export default function MobileBackLink({
  to,
  label = '戻る',
  children,
  className,
}: {
  to: string
  label?: string
  children?: ReactNode
  className?: string
}) {
  const guard = useUnsavedChangesGuard()
  const navigate = useNavigate()
  return (
    <Link
      to={to}
      title={label}
      aria-label={children ? undefined : label}
      onClick={(e) => {
        e.preventDefault()
        guard().then((ok) => {
          if (ok) navigate(to)
        })
      }}
      className={`md:hidden ${
        className ??
        '-ml-1.5 flex h-8 w-8 flex-none self-center items-center justify-center rounded-md text-[22px] leading-none text-ink-muted hover:bg-surface-muted'
      }`}
    >
      {children ?? '‹'}
    </Link>
  )
}
