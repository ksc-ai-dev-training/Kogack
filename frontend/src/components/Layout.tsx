import { useState } from 'react'
import { Link, NavLink, useMatch, useNavigate, useSearchParams } from 'react-router'
import { apiFetch } from '../lib/api'
import { avatarColorFor } from '../lib/avatarColor'
import { useMe } from '../hooks/useMe'
import { useChannels } from '../hooks/useChannels'
import { useDms } from '../hooks/useDms'
import { useScheduledMessages } from '../hooks/useScheduledMessages'
import JoinChannelModal from './JoinChannelModal'
import DmPickerModal from './DmPickerModal'
import ProfileEditModal from './ProfileEditModal'
import ScheduledMessagesModal from './ScheduledMessagesModal'
import type { Me } from '../types'

const ROLE_LABELS: Record<string, string> = {
  admin: 'システム管理者',
  member: '一般',
}
const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'bg-admin-bg text-admin-text',
  member: 'bg-member-bg text-member-text',
}

const navItemClass = (isActive: boolean) =>
  `flex items-center gap-2 rounded-[7px] px-2 py-1.5 text-[13px] ${
    isActive
      ? 'bg-accent-50 font-bold text-accent-700 shadow-[inset_3px_0_0_var(--color-accent-600)]'
      : 'text-ink hover:bg-surface-muted'
  }`

// S-02 共通ヘッダー＋サイドバー（詳細設計書 画面設計11.3節 Layout、画面モックアップS-03等の.sidebar）。
export default function Layout({ me, children }: { me: Me; children: React.ReactNode }) {
  const navigate = useNavigate()
  const { mutate: mutateMe } = useMe()
  const { joined } = useChannels()
  const { dms } = useDms()
  const { items: scheduledItems } = useScheduledMessages()
  const [modalOpen, setModalOpen] = useState(false)
  const [dmModalOpen, setDmModalOpen] = useState(false)
  const [profileModalOpen, setProfileModalOpen] = useState(false)
  const [scheduledModalOpen, setScheduledModalOpen] = useState(false)

  // S-06/S-08表示中はサイドバーをチャンネル一覧ではなく設定用ナビに差し替える（画面モックアップと同じ構成）。
  // タブ切替は?tab=クエリパラメータで行う（ThreadPanelの?threadと同じ考え方）。S-06は7タブ
  // （チャンネル管理者・基本設定・キャラクタ・振る舞い定義・参照ドキュメント範囲・定期投稿・
  // 自動応答トリガー）を実装済み。未実装タブ（スキル・反応モード・自動対応範囲）は出さない
  const settingsMatch = useMatch('/channels/:channelId/settings')
  const adminMatch = useMatch('/admin')
  const [searchParams] = useSearchParams()
  const settingsTab = searchParams.get('tab') ?? 'admin'
  const adminTab = searchParams.get('tab') ?? 'users'

  const logout = async () => {
    await apiFetch('/api/auth/logout', { method: 'POST' })
    // useMe()のSWRキャッシュを更新しないと、App.tsx側は依然ログイン中と判断して
    // /login を / へ跳ね返してしまう（ログアウトボタンが効かないように見えるバグの原因）。
    await mutateMe(null, { revalidate: false })
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex h-screen bg-surface-muted">
      <aside className="flex w-[260px] flex-none flex-col border-r border-line bg-surface-subtle">
        <div className="flex h-14 flex-none items-center gap-2 border-b border-line bg-surface px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent-600 to-accent-700 text-xs font-bold text-white">
            K
          </div>
          <span className="text-[15px] font-bold text-accent-700">Kogack</span>
          <button
            type="button"
            onClick={() => setScheduledModalOpen(true)}
            title="予約中のメッセージ"
            className={`ml-auto flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-semibold ${
              scheduledItems.length > 0
                ? 'border-accent-600 bg-accent-50 text-accent-700'
                : 'border-transparent text-ink-subtle hover:bg-surface-muted'
            }`}
          >
            🕐
            {scheduledItems.length > 0 && (
              <span className="rounded-full bg-accent-600 px-1.5 text-[10px] font-bold text-white">
                {scheduledItems.length}
              </span>
            )}
          </button>
          <NavLink
            to="/search"
            title="横断検索"
            className="rounded p-1.5 text-ink-subtle hover:bg-surface-muted hover:text-ink-muted"
          >
            🔍
          </NavLink>
        </div>

        {settingsMatch ? (
          <div className="flex-1 overflow-y-auto px-2.5 py-3.5">
            <div className="mb-1.5 px-2 text-[11px] font-bold tracking-wide text-ink-subtle">チャンネル設定</div>
            <ul>
              <li>
                <Link
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=admin`}
                  className={navItemClass(settingsTab === 'admin')}
                >
                  <span className="text-sm">👤</span>チャンネル管理者
                </Link>
              </li>
            </ul>
            <div className="mb-1.5 mt-4.5 px-2 text-[11px] font-bold tracking-wide text-ink-subtle">
              AI設定の項目
            </div>
            <ul>
              <li>
                <Link
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=general`}
                  className={navItemClass(settingsTab === 'general')}
                >
                  <span className="text-sm">⚙️</span>基本設定
                </Link>
              </li>
              <li>
                <Link
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=character`}
                  className={navItemClass(settingsTab === 'character')}
                >
                  <span className="text-sm">🎭</span>キャラクタ
                </Link>
              </li>
              <li>
                <Link
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=prompt`}
                  className={navItemClass(settingsTab === 'prompt')}
                >
                  <span className="text-sm">📝</span>振る舞い定義
                </Link>
              </li>
              <li>
                <Link
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=docscope`}
                  className={navItemClass(settingsTab === 'docscope')}
                >
                  <span className="text-sm">📁</span>参照ドキュメント範囲
                </Link>
              </li>
            </ul>
            <div className="mb-1.5 mt-4.5 px-2 text-[11px] font-bold tracking-wide text-ink-subtle">
              その他の設定
            </div>
            <ul>
              <li>
                <Link
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=recurring`}
                  className={navItemClass(settingsTab === 'recurring')}
                >
                  <span className="text-sm">🔁</span>定期投稿
                </Link>
              </li>
              <li>
                <Link
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=trigger`}
                  className={navItemClass(settingsTab === 'trigger')}
                >
                  <span className="text-sm">⚡</span>自動応答トリガー
                </Link>
              </li>
            </ul>
          </div>
        ) : adminMatch ? (
          <div className="flex-1 overflow-y-auto px-2.5 py-3.5">
            <div className="mb-1.5 px-2 text-[11px] font-bold tracking-wide text-ink-subtle">管理コンソール</div>
            <ul>
              <li>
                <Link to="/admin?tab=users" className={navItemClass(adminTab === 'users')}>
                  <span className="text-sm">👤</span>利用者管理
                </Link>
              </li>
              <li>
                <Link to="/admin?tab=docs" className={navItemClass(adminTab === 'docs')}>
                  <span className="text-sm">📁</span>ドキュメント参照範囲
                </Link>
              </li>
            </ul>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-2.5 py-3.5">
            <div className="flex items-center justify-between px-2 pb-1.5">
              <span className="text-[11px] font-bold tracking-wide text-ink-subtle">チャンネル</span>
              <button
                type="button"
                onClick={() => setModalOpen(true)}
                title="チャンネルに参加/作成"
                className="flex h-5 w-5 items-center justify-center rounded-[5px] text-ink-subtle hover:bg-accent-100 hover:text-accent-700"
              >
                ＋
              </button>
            </div>
            <ul>
              {joined.map((c) => {
                const unread = c.unread_count ?? 0
                return (
                  <li key={c.id} className="my-px">
                    <NavLink to={`/channels/${c.id}`} className={({ isActive }) => navItemClass(isActive)}>
                      <span className="flex-none text-ink-subtle">{c.is_public ? '#' : '🔒'}</span>
                      <span className={`min-w-0 flex-1 truncate ${unread > 0 ? 'font-bold text-ink' : ''}`}>
                        {c.name}
                      </span>
                      {unread > 0 && (
                        <span className="flex h-[17px] min-w-[17px] flex-none items-center justify-center rounded-full bg-accent-600 px-1 text-[10px] font-bold text-white">
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                    </NavLink>
                  </li>
                )
              })}
              {joined.length === 0 && (
                <li className="px-2 py-1.5 text-xs text-ink-subtle">参加中のチャンネルはありません</li>
              )}
            </ul>

            <div className="mt-4.5 flex items-center justify-between px-2 pb-1.5">
              <span className="text-[11px] font-bold tracking-wide text-ink-subtle">ダイレクトメッセージ</span>
              <button
                type="button"
                onClick={() => setDmModalOpen(true)}
                title="DMを開始"
                className="flex h-5 w-5 items-center justify-center rounded-[5px] text-ink-subtle hover:bg-accent-100 hover:text-accent-700"
              >
                ＋
              </button>
            </div>
            <ul>
              {dms.map((d) => {
                const label = d.members.map((m) => m.name).join('、')
                const firstMember = d.members[0]
                return (
                  <li key={d.id} className="my-px">
                    <NavLink to={`/dms/${d.id}`} className={({ isActive }) => navItemClass(isActive)}>
                      {firstMember?.picture_url ? (
                        <img
                          src={firstMember.picture_url}
                          alt=""
                          referrerPolicy="no-referrer"
                          className="h-5 w-5 flex-none rounded-full object-cover"
                        />
                      ) : (
                        <span
                          className="flex h-5 w-5 flex-none items-center justify-center rounded-full text-[9.5px] font-bold text-white"
                          style={{ background: avatarColorFor(firstMember?.id ?? d.id) }}
                        >
                          {firstMember?.name.slice(0, 1) ?? '?'}
                        </span>
                      )}
                      <span className={`min-w-0 flex-1 truncate ${d.unread_count > 0 ? 'font-bold text-ink' : ''}`}>
                        {label}
                      </span>
                      {d.unread_count > 0 && (
                        <span className="flex h-[17px] min-w-[17px] flex-none items-center justify-center rounded-full bg-accent-600 px-1 text-[10px] font-bold text-white">
                          {d.unread_count > 99 ? '99+' : d.unread_count}
                        </span>
                      )}
                    </NavLink>
                  </li>
                )
              })}
              {dms.length === 0 && <li className="px-2 py-1.5 text-xs text-ink-subtle">DMはまだありません</li>}
            </ul>
          </div>
        )}

        <div className="flex-none border-t border-line p-3">
          {me.role === 'admin' && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `mb-2 flex items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-xs font-medium ${
                  isActive ? 'bg-accent-50 text-accent-700' : 'text-ink-muted hover:bg-surface-muted'
                }`
              }
            >
              🛠 管理コンソール
            </NavLink>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setProfileModalOpen(true)}
              title="プロフィールを編集"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-[7px] py-0.5 text-left hover:bg-surface-muted"
            >
              {me.picture_url ? (
                <img
                  src={me.picture_url}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-[30px] w-[30px] flex-none rounded-full object-cover"
                />
              ) : (
                <div className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full bg-[#cbd5f5] text-xs font-bold text-accent-700">
                  {me.name.slice(0, 1)}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-semibold text-ink">{me.name}</div>
                <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${ROLE_BADGE_CLASS[me.role]}`}>
                  {ROLE_LABELS[me.role]}
                </span>
              </div>
            </button>
            <button
              type="button"
              onClick={logout}
              title="ログアウト"
              className="flex-none rounded px-2 py-1 text-xs text-ink-subtle hover:bg-surface-muted hover:text-ink-muted"
            >
              ログアウト
            </button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-hidden">{children}</main>

      {modalOpen && <JoinChannelModal onClose={() => setModalOpen(false)} />}
      {dmModalOpen && <DmPickerModal onClose={() => setDmModalOpen(false)} />}
      {profileModalOpen && <ProfileEditModal me={me} onClose={() => setProfileModalOpen(false)} />}
      {scheduledModalOpen && <ScheduledMessagesModal onClose={() => setScheduledModalOpen(false)} />}
    </div>
  )
}
