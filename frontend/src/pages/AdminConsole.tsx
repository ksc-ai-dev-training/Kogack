import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useAdminUsers } from '../hooks/useAdminUsers'
import { useMe } from '../hooks/useMe'
import { apiFetch, ApiError } from '../lib/api'
import { avatarColorFor } from '../lib/avatarColor'
import { useToast } from '../components/Toast'
import { useConfirm } from '../components/ui/ConfirmDialog'
import type { Role } from '../types'

function formatDateTime(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

// S-08 管理コンソール（このスライスは「利用者管理」タブのみ実装。ドキュメント参照範囲・
// AI利用状況・監査ログの3タブはDrive連携・AI呼び出し・監査ログ基盤が未実装のため対象外）
export default function AdminConsole() {
  const navigate = useNavigate()
  const { me } = useMe()
  const { users, error, mutate } = useAdminUsers()
  const toast = useToast()
  const confirm = useConfirm()
  const [query, setQuery] = useState('')

  useEffect(() => {
    // 基本設計書4.2節「設計判断」: 非adminのS-08アクセスはS-02へトースト通知付きでリダイレクト
    if (error instanceof ApiError && error.status === 403) {
      navigate('/', { replace: true })
      toast('このページを表示する権限がありません', 'info')
    }
  }, [error])

  const q = query.trim().toLowerCase()
  const filtered = users.filter(
    (u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
  )
  const activeCount = users.filter((u) => u.is_active).length

  const changeRole = async (userId: string, role: Role) => {
    try {
      await apiFetch(`/api/admin/users/${userId}`, { method: 'PUT', body: JSON.stringify({ role }) })
      await mutate()
      toast('ロールを変更しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '変更に失敗しました', 'error')
    }
  }

  const toggleActive = async (userId: string, name: string, nextActive: boolean) => {
    if (!nextActive) {
      const ok = await confirm({
        title: 'アカウントを無効化',
        message: `${name} さんを無効化しますか？ ログインできなくなります（過去の発言は削除されません）。`,
        confirmLabel: '無効化する',
        danger: true,
      })
      if (!ok) return
    }
    try {
      await apiFetch(`/api/admin/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: nextActive }),
      })
      await mutate()
      toast(nextActive ? '有効化しました' : '無効化しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '変更に失敗しました', 'error')
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-none border-b border-line bg-surface px-7 py-4">
        <Link to="/" className="text-xs text-accent-700 hover:underline">
          ← ワークスペースに戻る
        </Link>
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-[16px] font-bold text-ink">利用者管理</span>
        </div>
        <p className="mt-1.5 max-w-[640px] text-[12.5px] leading-relaxed text-ink-muted">
          新規作成・削除は行いません（Google認証での初回アクセス時に自動登録）。ロールはadmin/memberの2種類のみで、
          チャンネル管理者はチャンネル単位の権限のため参考表示のみです（変更は各チャンネルの「チャンネル設定」から行います）。
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-5">
        <div className="mb-3.5 flex items-center gap-2.5">
          <div className="flex w-[260px] flex-none items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-1.5">
            <svg width="12" height="12" viewBox="0 0 20 20" fill="none" aria-hidden="true" className="flex-none">
              <circle cx="9" cy="9" r="6.2" stroke="#8a8f98" strokeWidth="1.6" />
              <path d="M17 17l-3.6-3.6" stroke="#8a8f98" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="氏名・メールアドレスで検索"
              className="w-full text-[12.5px] text-ink outline-none placeholder:text-ink-subtle"
            />
          </div>
          <span className="ml-auto text-[11px] text-ink-subtle">
            有効 {activeCount}名 ／ 無効 {users.length - activeCount}名
          </span>
        </div>

        <table className="w-full border-collapse text-left text-[12.5px]">
          <thead>
            <tr>
              {['氏名', 'メールアドレス', 'ロール', 'チャンネル管理者', 'ステータス', '最終ログイン', ''].map((h) => (
                <th
                  key={h}
                  className="border-b border-line-strong px-3 py-1.5 text-[11px] font-bold text-ink-subtle"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id} className={`border-b border-line ${u.is_active ? '' : 'text-ink-subtle'}`}>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span
                      className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-bold text-white"
                      style={{ background: avatarColorFor(u.id) }}
                    >
                      {u.name.slice(0, 1)}
                    </span>
                    <span className={`font-semibold ${u.is_active ? 'text-ink' : 'text-ink-subtle line-through'}`}>
                      {u.name}
                    </span>
                    {u.id === me?.id && <span className="text-[10px] text-ink-subtle">(本人)</span>}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-ink-muted">{u.email}</td>
                <td className="px-3 py-2.5">
                  <select
                    value={u.role}
                    onChange={(e) => changeRole(u.id, e.target.value as Role)}
                    disabled={u.id === me?.id}
                    title={u.id === me?.id ? '自分自身のロールは変更できません（管理者ロックアウト防止）' : undefined}
                    className={`rounded px-2 py-0.5 text-[11px] font-semibold outline-none disabled:opacity-60 ${
                      u.role === 'admin' ? 'bg-admin-bg text-admin-text' : 'bg-member-bg text-member-text'
                    }`}
                  >
                    <option value="admin">admin</option>
                    <option value="member">member</option>
                  </select>
                </td>
                <td className="px-3 py-2.5 text-ink-subtle">
                  {u.chadmin_channels.length > 0 ? u.chadmin_channels.map((c) => `# ${c}`).join('、') : '—'}
                </td>
                <td className="px-3 py-2.5">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      u.is_active ? 'bg-ok-bg text-ok-text' : 'bg-off-bg text-off-text'
                    }`}
                  >
                    {u.is_active ? '有効' : '無効'}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-ink-subtle">{formatDateTime(u.last_login_at)}</td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    type="button"
                    onClick={() => toggleActive(u.id, u.name, !u.is_active)}
                    disabled={u.id === me?.id}
                    className="text-[11.5px] font-medium text-accent-700 hover:underline disabled:opacity-30 disabled:hover:no-underline"
                  >
                    {u.is_active ? '無効化' : '有効化'}
                  </button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-sm text-ink-subtle">
                  該当する利用者がいません。
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <p className="mt-3 text-[11px] leading-relaxed text-ink-subtle">
          無効化しても、過去の発言は削除されず表示を維持します。退職者のGoogleアカウントは無効化と連動してログインできなくなります。
        </p>
      </div>
    </div>
  )
}
