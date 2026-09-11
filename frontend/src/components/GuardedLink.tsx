import { Link, NavLink, useLocation, useNavigate, type LinkProps, type NavLinkProps } from 'react-router'
import { useUnsavedChangesGuard } from '../lib/unsavedChanges'

// 未保存の変更がある状態でクリックされたら確認ダイアログを挟んでから遷移する、Link/NavLinkの
// 代替コンポーネント（lib/unsavedChanges.ts参照、2026-09-11）。文字列のtoのみ対応する
// （このアプリの既存の呼び出し側はいずれも文字列のtoを渡しているため、To型全体への
// 対応は不要と判断した）。同じ場所へのクリック（既に表示中のタブを再度クリックする等）は
// 確認を挟まず素通りさせる。
function isSameLocation(to: string, pathname: string, search: string) {
  return to === `${pathname}${search}` || to === pathname
}

export function GuardedLink({ to, onClick, ...rest }: LinkProps & { to: string }) {
  const guard = useUnsavedChangesGuard()
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <Link
      to={to}
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented) return
        if (isSameLocation(to, location.pathname, location.search)) return
        e.preventDefault()
        guard().then((ok) => {
          if (ok) navigate(to)
        })
      }}
      {...rest}
    />
  )
}

export function GuardedNavLink({ to, onClick, ...rest }: NavLinkProps & { to: string }) {
  const guard = useUnsavedChangesGuard()
  const navigate = useNavigate()
  const location = useLocation()
  return (
    <NavLink
      to={to}
      onClick={(e) => {
        onClick?.(e)
        if (e.defaultPrevented) return
        if (isSameLocation(to, location.pathname, location.search)) return
        e.preventDefault()
        guard().then((ok) => {
          if (ok) navigate(to)
        })
      }}
      {...rest}
    />
  )
}
