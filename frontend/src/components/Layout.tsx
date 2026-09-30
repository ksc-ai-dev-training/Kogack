import { useEffect, useRef, useState } from 'react'
import { useLocation, useMatch, useNavigate, useSearchParams } from 'react-router'
import { apiFetch } from '../lib/api'
import { avatarColorFor } from '../lib/avatarColor'
import { useMe } from '../hooks/useMe'
import { useChannels } from '../hooks/useChannels'
import { useDms } from '../hooks/useDms'
import { useScheduledMessages } from '../hooks/useScheduledMessages'
import { useDesktopNotifications } from '../hooks/useDesktopNotifications'
import { useUnreadTitleBadge } from '../hooks/useUnreadTitleBadge'
import { usePushSubscription } from '../hooks/usePushSubscription'
import { useUiZoom } from '../hooks/useUiZoom'
import { useDraftKeys } from '../hooks/useDraftKeys'
import { useIsMobile } from '../hooks/useIsMobile'
import { UI_ZOOM_LABELS, UI_ZOOM_ORDER } from '../lib/uiZoom'
import { useUnsavedChangesGuard } from '../lib/unsavedChanges'
import { GuardedLink, GuardedNavLink } from './GuardedLink'
import MobileBackLink from './MobileBackLink'
import NotificationSettingsButton from './NotificationSettingsButton'
import JoinChannelModal from './JoinChannelModal'
import DmPickerModal from './DmPickerModal'
import ProfileEditModal from './ProfileEditModal'
import ScheduledMessagesModal from './ScheduledMessagesModal'
import { readSidebarCollapsed, saveSidebarCollapsed, type SidebarCollapsed } from '../lib/sidebarSections'
import { rememberNonHelpPath } from '../lib/helpReturnPath'
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
      : 'text-ink hover:bg-sidebar-hover'
  }`

// サイドバーの「チャンネル」「ダイレクトメッセージ」見出し。押すと一覧を開閉する（lib/sidebarSections.ts）
function SectionToggle({ label, collapsed, onToggle }: { label: string; collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      title={collapsed ? `${label}の一覧を開く` : `${label}の一覧を閉じる（未読のあるものは表示されたままになります）`}
      className="flex items-center gap-1 rounded-[5px] pr-1 text-[11px] font-bold tracking-wide text-ink-subtle hover:text-ink"
    >
      <span className={`inline-block w-2.5 text-[9px] transition-transform ${collapsed ? '-rotate-90' : ''}`}>▼</span>
      {label}
    </button>
  )
}

// S-02 共通ヘッダー＋サイドバー（詳細設計書 画面設計11.3節 Layout、画面モックアップS-03等の.sidebar）。

// サイドバーのDMを既定で隠すまでの、やり取りが無い日数（2026-09-30）
const DM_STALE_DAYS = 30
export default function Layout({ me, children }: { me: Me; children: React.ReactNode }) {
  const navigate = useNavigate()
  const { mutate: mutateMe } = useMe()
  const { joined } = useChannels()
  const { dms } = useDms()
  const { items: scheduledItems } = useScheduledMessages()
  // メッセージ下書きの永続化（ユーザーからの明示的な要望「下書きが残っているチャンネルやDMは
  // 見てわかるような記述やマークを付けてほしい」）。lib/drafts.ts参照
  const draftKeys = useDraftKeys()
  // バグ修正（2026-09-14、ユーザーからの報告「DMを送ると相手に通知が二つ送られてくる」）:
  // ①②は独立に動く設計だが、②はタブの表示状態に関わらず常に届くため、①が発火する条件
  // （タブが非表示/非フォーカス）と重なると同じ新着に対して両方が発火し二重通知になっていた。
  // ②の購読が実際に成立したかをrefで持ち、①（useDesktopNotifications）へ渡して発火時に
  // 参照させる（Reactの再レンダーは不要なためstateではなくref。usePushSubscriptionが成功時に
  // このrefへ書き込む）
  const pushActiveRef = useRef(false)
  // ブラウザのデスクトップ通知①（既存ポーリングのunread_count/unread_mention_count増分に相乗り。
  // タブ非表示時のみ通知）。notif_modeはサーバー側（me.notif_mode）を正とする（2026-09-11、②追加時に変更）
  const {
    permission: notifPermission,
    requestPermission: requestNotifPermission,
    mode: notifMode,
    setMode: setNotifMode,
    supported: notifSupported,
  } = useDesktopNotifications(joined, dms, me.id, me.notif_mode, pushActiveRef)
  // デスクトップ通知②（Web Push、タブ・ブラウザを閉じていても届く）。①の許可が下りたタイミングで
  // Service Workerの登録・購読を試みる（VAPID未設定ならサーバー側で何もしないだけで①は影響を受けない）
  usePushSubscription(notifPermission, pushActiveRef)
  // ブラウザのタブタイトルに未読件数を表示する（ユーザーからの明示的な要望「通知が来たときに、
  // ブラウザのタイトル部分でも新着メッセージが分かるようにしてほしい」）。通知の許可状態に関わらず
  // 常時反映する（サイドバーの未読バッジと同じソース、useDesktopNotifications.tsとは独立）
  useUnreadTitleBadge(joined, dms)
  // UI全体の表示倍率（案A、ユーザーからの要望「設定で文字の大きさを変えたい」）
  const { zoom: uiZoom, setZoom: setUiZoom } = useUiZoom()
  const [modalOpen, setModalOpen] = useState(false)
  const [dmModalOpen, setDmModalOpen] = useState(false)
  const [profileModalOpen, setProfileModalOpen] = useState(false)
  const [scheduledModalOpen, setScheduledModalOpen] = useState(false)

  // S-06/S-08表示中はサイドバーをチャンネル一覧ではなく設定用ナビに差し替える（画面モックアップと同じ構成）。
  // タブ切替は?tab=クエリパラメータで行う（ThreadPanelの?threadと同じ考え方）。S-06は9タブ
  // （チャンネル管理者・基本設定・キャラクタ・振る舞い定義・参照ドキュメント範囲・スキルと対応範囲設定・
  // 反応モード・定期投稿・自動応答トリガー）を実装済み。「スキルと対応範囲設定」は旧「スキル」「自動対応範囲」
  // を2026-09-29に統合したもので、旧URLの?tab=autoもこの項目を選択状態にする
  const settingsMatch = useMatch('/channels/:channelId/settings')
  const adminMatch = useMatch('/admin')
  const [searchParams] = useSearchParams()
  const isMobile = useIsMobile()
  // スマホ表示では?tab=無しのURLが「項目一覧（サイドバー）」画面を表すため、どれも選択状態にしない
  const settingsTab = searchParams.get('tab') ?? (isMobile ? null : 'admin')
  const adminTab = searchParams.get('tab') ?? (isMobile ? null : 'users')

  // 「チャンネル」「ダイレクトメッセージ」見出しの開閉（lib/sidebarSections.ts）。閉じている間も、
  // 未読・メンションのあるもの（ミュート中は除く＝バッジを出さないものは出さない）と、今開いている
  // ものだけは表示し続ける（閉じたせいで新着を見落とさない・今いる場所が分かるようにするため）
  const [collapsed, setCollapsed] = useState<SidebarCollapsed>(readSidebarCollapsed)
  const toggleSection = (key: keyof SidebarCollapsed) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      saveSidebarCollapsed(next)
      return next
    })
  }
  // 操作マニュアル（/help）の「← 戻る」の戻り先として、/help以外の画面へ移るたびに場所を覚える
  // （lib/helpReturnPath.ts）
  const location = useLocation()
  // スマホ表示（F-32 モバイル対応レイアウト、2026-09-30）はSlackのアプリと同じく、サイドバーだけの
  // 画面と会話（メイン領域）だけの画面を分ける。サイドバー側を出すのは次のURLのとき:
  //   /（ワークスペース） / チャンネル設定・管理コンソールの?tab=無し（設定項目の一覧）
  // それ以外はメイン領域を全幅で出し、各画面ヘッダー左端の「‹」（MobileBackLink）でサイドバー側へ戻る。
  // PC表示（md以上）では従来どおり両方を並べる。出し分けはCSS（max-md:hidden）だけで行い、
  // どちらの画面もマウントしたままにする（権限チェック等の各画面のuseEffectを従来どおり動かすため）
  const mobileShowsSidebar =
    location.pathname === '/' || ((settingsMatch || adminMatch) && !searchParams.has('tab'))
  useEffect(() => {
    if (location.pathname !== '/help') rememberNonHelpPath(`${location.pathname}${location.search}${location.hash}`)
  }, [location.pathname, location.search, location.hash])
  const currentChannelId = useMatch('/channels/:channelId')?.params.channelId
  const currentDmId = useMatch('/dms/:dmId')?.params.dmId
  const visibleChannels = collapsed.channels
    ? joined.filter(
        (c) =>
          c.id === currentChannelId ||
          (c.notif_mode !== 'off' && ((c.unread_count ?? 0) > 0 || (c.unread_mention_count ?? 0) > 0)),
      )
    : joined
  // DMは相手が増えやすいため、見出しを開いていても30日以上やり取りの無いDMは既定で隠し、一覧の末尾の
  // 「ほかN件のDMを表示」で全件を出せるようにする（2026-09-30、ユーザーからの要望）。並びはA-16が
  // 最後にやり取りした順で返す。未読があるDM・今開いているDMは期間に関係なく常に表示する
  const [showStaleDms, setShowStaleDms] = useState(false)
  const staleDmCutoff = Date.now() - DM_STALE_DAYS * 24 * 60 * 60 * 1000
  const isStaleDm = (d: (typeof dms)[number]) => new Date(d.last_activity_at).getTime() < staleDmCutoff
  const visibleDms = collapsed.dms
    ? dms.filter((d) => d.id === currentDmId || (d.notif_mode !== 'off' && d.unread_count > 0))
    : showStaleDms
      ? dms
      : dms.filter(
          (d) => !isStaleDm(d) || d.id === currentDmId || d.unread_count > 0 || d.unread_mention_count > 0,
        )
  const staleDmCount = dms.filter(isStaleDm).length
  const hiddenDmCount = collapsed.dms ? 0 : dms.length - visibleDms.length

  const guardNavigation = useUnsavedChangesGuard()

  const logout = async () => {
    // 未保存の変更ガード（2026-09-11）: ログアウトはLinkではないため、GuardedLink同様に
    // ここでも確認を挟む
    if (!(await guardNavigation())) return
    await apiFetch('/api/auth/logout', { method: 'POST' })
    // useMe()のSWRキャッシュを更新しないと、App.tsx側は依然ログイン中と判断して
    // /login を / へ跳ね返してしまう（ログアウトボタンが効かないように見えるバグの原因）。
    await mutateMe(null, { revalidate: false })
    navigate('/login', { replace: true })
  }

  return (
    // documentElement の zoom で全体を拡大する（src/lib/uiZoom.ts）。ビューポート基準の全画面
    // サイズだけは zoom で割り戻さないと縦横スクロールが出るため calc で補正する。
    // 高さはdvh（スマホのアドレスバーの出入りに追従する）。vhのままだとスマホでは投稿欄が画面外に隠れる
    <div className="flex h-[calc(100dvh/var(--ui-zoom))] w-[calc(100vw/var(--ui-zoom))] bg-surface-muted">
      <aside
        className={`flex w-[260px] flex-none flex-col border-r border-line bg-sidebar max-md:w-full max-md:border-r-0 ${
          mobileShowsSidebar ? '' : 'max-md:hidden'
        }`}
      >
        <div className="flex h-14 flex-none items-center gap-2 border-b border-line bg-sidebar px-4">
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
                : 'border-transparent text-ink-subtle hover:bg-sidebar-hover'
            }`}
          >
            🕐
            {scheduledItems.length > 0 && (
              <span className="rounded-full bg-accent-600 px-1.5 text-[10px] font-bold text-white">
                {scheduledItems.length}
              </span>
            )}
          </button>
          {notifSupported && (
            <NotificationSettingsButton
              permission={notifPermission}
              requestPermission={requestNotifPermission}
              mode={notifMode}
              setMode={setNotifMode}
            />
          )}
        </div>

        {settingsMatch ? (
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-3.5">
            <div className="mb-1.5 flex items-center gap-1 px-2 text-[11px] font-bold tracking-wide text-ink-subtle">
              <MobileBackLink to={`/channels/${settingsMatch.params.channelId}`} label="チャンネルに戻る" />
              チャンネル設定
            </div>
            <ul>
              <li>
                <GuardedLink
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=admin`}
                  className={navItemClass(settingsTab === 'admin')}
                >
                  <span className="text-sm">👤</span>チャンネル管理者
                </GuardedLink>
              </li>
            </ul>
            <div className="mb-1.5 mt-4.5 px-2 text-[11px] font-bold tracking-wide text-ink-subtle">
              AI設定の項目
            </div>
            <ul>
              <li>
                <GuardedLink
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=general`}
                  className={navItemClass(settingsTab === 'general')}
                >
                  <span className="text-sm">⚙️</span>基本設定
                </GuardedLink>
              </li>
              <li>
                <GuardedLink
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=character`}
                  className={navItemClass(settingsTab === 'character')}
                >
                  <span className="text-sm">🎭</span>キャラクタ
                </GuardedLink>
              </li>
              <li>
                <GuardedLink
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=prompt`}
                  className={navItemClass(settingsTab === 'prompt')}
                >
                  <span className="text-sm">📝</span>振る舞い定義
                </GuardedLink>
              </li>
              <li>
                <GuardedLink
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=docscope`}
                  className={navItemClass(settingsTab === 'docscope')}
                >
                  <span className="text-sm">📁</span>参照ドキュメント範囲
                </GuardedLink>
              </li>
              <li>
                <GuardedLink
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=skills`}
                  className={navItemClass(settingsTab === 'skills' || settingsTab === 'auto')}
                >
                  <span className="text-sm">🛠️</span>スキルと対応範囲設定
                </GuardedLink>
              </li>
              <li>
                <GuardedLink
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=reaction`}
                  className={navItemClass(settingsTab === 'reaction')}
                >
                  <span className="text-sm">💬</span>反応モード
                </GuardedLink>
              </li>
            </ul>
            <div className="mb-1.5 mt-4.5 px-2 text-[11px] font-bold tracking-wide text-ink-subtle">
              その他の設定
            </div>
            <ul>
              <li>
                <GuardedLink
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=recurring`}
                  className={navItemClass(settingsTab === 'recurring')}
                >
                  <span className="text-sm">🔁</span>定期投稿
                </GuardedLink>
              </li>
              <li>
                <GuardedLink
                  to={`/channels/${settingsMatch.params.channelId}/settings?tab=trigger`}
                  className={navItemClass(settingsTab === 'trigger')}
                >
                  <span className="text-sm">⚡</span>自動応答トリガー
                </GuardedLink>
              </li>
            </ul>
          </div>
        ) : adminMatch ? (
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-3.5">
            <div className="mb-1.5 flex items-center gap-1 px-2 text-[11px] font-bold tracking-wide text-ink-subtle">
              <MobileBackLink to="/" label="ワークスペースに戻る" />
              管理コンソール
            </div>
            <ul>
              <li>
                <GuardedLink to="/admin?tab=users" className={navItemClass(adminTab === 'users')}>
                  <span className="text-sm">👤</span>利用者管理
                </GuardedLink>
              </li>
              <li>
                <GuardedLink to="/admin?tab=docs" className={navItemClass(adminTab === 'docs')}>
                  <span className="text-sm">📁</span>ドキュメント参照範囲
                </GuardedLink>
              </li>
              <li>
                <GuardedLink to="/admin?tab=usage" className={navItemClass(adminTab === 'usage')}>
                  <span className="text-sm">💰</span>AI利用状況・コスト
                </GuardedLink>
              </li>
              <li>
                <GuardedLink to="/admin?tab=audit" className={navItemClass(adminTab === 'audit')}>
                  <span className="text-sm">📋</span>監査ログ
                </GuardedLink>
              </li>
            </ul>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-3.5">
            <div className="flex items-center justify-between px-2 pb-1.5">
              <SectionToggle label="チャンネル" collapsed={collapsed.channels} onToggle={() => toggleSection('channels')} />
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
              {visibleChannels.map((c) => {
                // チャンネルごとの通知設定（2026-09-11）で「オフ（ミュート）」を選んだチャンネルは
                // 未読バッジ・太字表示も抑える（全体設定のoffはバッジには影響しない既存仕様とは
                // 意図的に区別。ユーザーが選んだ推奨案どおり。'default'/'all'/'mentions'は通知の
                // 出し分けのみに関わり、バッジ表示自体は従来どおり）
                const muted = c.notif_mode === 'off'
                const unread = muted ? 0 : (c.unread_count ?? 0)
                const mentions = muted ? 0 : (c.unread_mention_count ?? 0)
                const hasDraft = draftKeys.has(`c:${c.id}`)
                return (
                  <li key={c.id} className="my-px">
                    <GuardedNavLink to={`/channels/${c.id}`} className={({ isActive }) => navItemClass(isActive)}>
                      <span className="flex-none text-ink-subtle">{c.is_public ? '#' : '🔒'}</span>
                      <span className={`min-w-0 flex-1 truncate ${unread > 0 ? 'font-bold text-ink' : ''}`}>
                        {c.name}
                      </span>
                      {hasDraft && (
                        <span title="下書きがあります" aria-label="下書きがあります" className="flex-none text-[11px]">
                          ✏️
                        </span>
                      )}
                      {mentions > 0 ? (
                        // 名指しされた発言がある＝赤い@バッジ（「チャンネルが賑やか」なだけの
                        // グレーの件数バッジと区別する）
                        <span
                          title={`あなたへのメンション ${mentions} 件`}
                          className="flex h-[17px] min-w-[17px] flex-none items-center justify-center rounded-full bg-danger-text px-1 text-[10px] font-bold text-white"
                        >
                          @{mentions > 99 ? '99+' : mentions}
                        </span>
                      ) : unread > 0 ? (
                        <span className="flex h-[17px] min-w-[17px] flex-none items-center justify-center rounded-full bg-accent-600 px-1 text-[10px] font-bold text-white">
                          {unread > 99 ? '99+' : unread}
                        </span>
                      ) : null}
                    </GuardedNavLink>
                  </li>
                )
              })}
              {joined.length === 0 && !collapsed.channels && (
                <li className="px-2 py-1.5 text-xs text-ink-subtle">参加中のチャンネルはありません</li>
              )}
            </ul>

            <div className="mt-4.5 flex items-center justify-between px-2 pb-1.5">
              <SectionToggle label="ダイレクトメッセージ" collapsed={collapsed.dms} onToggle={() => toggleSection('dms')} />
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
              {visibleDms.map((d) => {
                // 自分専用DM（F-05、is_self）はmembersに自分自身が入るため、そのまま氏名を出すと
                // 紛らわしい（DmView.tsxのタイトル表記と揃える）
                const label = d.is_self ? '自分（メモ）' : d.members.map((m) => m.name).join('、')
                const firstMember = d.members[0]
                const hasDraft = draftKeys.has(`d:${d.id}`)
                // DMごとの通知設定（2026-09-15）で「オフ（ミュート）」を選んだDMは、チャンネルと
                // 同じ考え方（joined.mapの`muted`参照）で未読バッジ・太字表示も抑える
                const muted = d.notif_mode === 'off'
                const unread = muted ? 0 : d.unread_count
                return (
                  <li key={d.id} className="my-px">
                    <GuardedNavLink to={`/dms/${d.id}`} className={({ isActive }) => navItemClass(isActive)}>
                      {d.is_self && <span className="flex-none text-[13px]">📝</span>}
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
                      <span className={`min-w-0 flex-1 truncate ${unread > 0 ? 'font-bold text-ink' : ''}`}>
                        {label}
                      </span>
                      {hasDraft && (
                        <span title="下書きがあります" aria-label="下書きがあります" className="flex-none text-[11px]">
                          ✏️
                        </span>
                      )}
                      {unread > 0 && (
                        <span className="flex h-[17px] min-w-[17px] flex-none items-center justify-center rounded-full bg-accent-600 px-1 text-[10px] font-bold text-white">
                          {unread > 99 ? '99+' : unread}
                        </span>
                      )}
                    </GuardedNavLink>
                  </li>
                )
              })}
              {dms.length === 0 && !collapsed.dms && <li className="px-2 py-1.5 text-xs text-ink-subtle">DMはまだありません</li>}
              {!collapsed.dms && (hiddenDmCount > 0 || (showStaleDms && staleDmCount > 0)) && (
                <li>
                  <button
                    type="button"
                    onClick={() => setShowStaleDms((v) => !v)}
                    title={`${DM_STALE_DAYS}日以上やり取りの無いDM（未読のあるDMは常に表示）`}
                    className="w-full rounded-[7px] px-2 py-1 text-left text-xs text-ink-subtle hover:bg-sidebar-hover hover:text-ink-muted"
                  >
                    {showStaleDms ? '古いDMを隠す' : `ほか${hiddenDmCount}件を表示`}
                  </button>
                </li>
              )}
            </ul>
          </div>
        )}

        <div className="flex-none border-t border-line p-3">
          <div className="mb-2 flex items-center gap-1.5">
            <span className="flex-none text-[11px] text-ink-subtle">文字サイズ</span>
            <div className="flex flex-1 overflow-hidden rounded-md border border-line">
              {UI_ZOOM_ORDER.map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => setUiZoom(z)}
                  aria-pressed={uiZoom === z}
                  title={`文字・表示の大きさを「${UI_ZOOM_LABELS[z]}」にする`}
                  className={`flex-1 border-l border-line py-0.5 text-[11px] first:border-l-0 ${
                    uiZoom === z
                      ? 'bg-accent-600 font-semibold text-white'
                      : 'text-ink-muted hover:bg-sidebar-hover'
                  }`}
                >
                  {UI_ZOOM_LABELS[z]}
                </button>
              ))}
            </div>
          </div>
          <GuardedNavLink
            to="/help"
            className={({ isActive }) =>
              `mb-1 flex items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-xs font-medium ${
                isActive ? 'bg-accent-50 text-accent-700' : 'text-ink-muted hover:bg-sidebar-hover'
              }`
            }
          >
            📖 操作マニュアル
          </GuardedNavLink>
          {me.role === 'admin' && (
            <GuardedNavLink
              to="/admin"
              className={({ isActive }) =>
                `mb-2 flex items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-xs font-medium ${
                  isActive ? 'bg-accent-50 text-accent-700' : 'text-ink-muted hover:bg-sidebar-hover'
                }`
              }
            >
              🛠 管理コンソール
            </GuardedNavLink>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setProfileModalOpen(true)}
              title="プロフィールを編集"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-[7px] py-0.5 text-left hover:bg-sidebar-hover"
            >
              {me.picture_url ? (
                <img
                  src={me.picture_url}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-[30px] w-[30px] flex-none rounded-full object-cover"
                />
              ) : (
                <div
                  className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-full text-xs font-bold text-white"
                  style={{ background: avatarColorFor(me.id) }}
                >
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
              className="flex-none rounded px-2 py-1 text-xs text-ink-subtle hover:bg-sidebar-hover hover:text-ink-muted"
            >
              ログアウト
            </button>
          </div>
        </div>
      </aside>

      <main className={`min-w-0 flex-1 overflow-hidden ${mobileShowsSidebar ? 'max-md:hidden' : ''}`}>{children}</main>

      {modalOpen && <JoinChannelModal onClose={() => setModalOpen(false)} />}
      {dmModalOpen && <DmPickerModal onClose={() => setDmModalOpen(false)} />}
      {profileModalOpen && <ProfileEditModal me={me} onClose={() => setProfileModalOpen(false)} />}
      {scheduledModalOpen && <ScheduledMessagesModal onClose={() => setScheduledModalOpen(false)} />}
    </div>
  )
}
