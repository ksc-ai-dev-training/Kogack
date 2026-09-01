import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useAdminUsers } from '../hooks/useAdminUsers'
import { useAuditLogs } from '../hooks/useAuditLogs'
import { useDocFolders } from '../hooks/useDocFolders'
import { useUsageStats } from '../hooks/useUsageStats'
import { useMe } from '../hooks/useMe'
import { apiFetch, ApiError } from '../lib/api'
import { avatarColorFor } from '../lib/avatarColor'
import { useToast } from '../components/Toast'
import { useConfirm } from '../components/ui/ConfirmDialog'
import type { AdminUser, DocFolder, Me, Role, UsageLimit, UsageStats } from '../types'

function formatDateTime(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

function formatYen(yen: number) {
  return `¥${Math.round(yen).toLocaleString('ja-JP')}`
}

function currentMonthStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

// S-08 管理コンソール。「利用者管理」「ドキュメント参照範囲」「AI利用状況・コスト」「監査ログ」の
// 4タブを実装。タブ切替はS-06 ChannelSettingsと同じ?tab=クエリパラメータで行う（Layout.tsxと共有）。
export default function AdminConsole() {
  const navigate = useNavigate()
  const { me } = useMe()
  const { error } = useAdminUsers()
  const toast = useToast()
  const [searchParams] = useSearchParams()
  const tab = searchParams.get('tab') ?? 'users'

  useEffect(() => {
    // 基本設計書4.2節「設計判断」: 非adminのS-08アクセスはS-02へトースト通知付きでリダイレクト
    if (error instanceof ApiError && error.status === 403) {
      navigate('/', { replace: true })
      toast('このページを表示する権限がありません', 'info')
    }
  }, [error])

  return (
    <div className="flex h-full flex-col">
      {tab === 'docs' ? (
        <DocFoldersTab />
      ) : tab === 'usage' ? (
        <UsageTab />
      ) : tab === 'audit' ? (
        <AuditLogTab />
      ) : (
        <UsersTab me={me} />
      )}
    </div>
  )
}

// A-36/A-37: 利用者管理タブ本体（従来のAdminConsole本体をそのまま切り出したもの）
function UsersTab({ me }: { me: Me | null }) {
  const { users, mutate } = useAdminUsers()
  const toast = useToast()
  const confirm = useConfirm()
  const [query, setQuery] = useState('')

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
                    {u.picture_url ? (
                      <img
                        src={u.picture_url}
                        alt=""
                        referrerPolicy="no-referrer"
                        className="h-6 w-6 flex-none rounded-full object-cover"
                      />
                    ) : (
                      <span
                        className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-bold text-white"
                        style={{ background: avatarColorFor(u.id) }}
                      >
                        {u.name.slice(0, 1)}
                      </span>
                    )}
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

// A-38〜A-40: ドキュメント参照範囲タブ本体（F-22）。このスライスはフォルダの登録・削除のみを
// 対象とし、「今すぐ同期」（A-41、実際のDrive同期・埋め込み索引生成）は次スライスで実装するため
// ここではボタンを無効表示に留める（CLAUDE.md実装状況節）
function DocFoldersTab() {
  const { folders, mutate } = useDocFolders()
  const toast = useToast()
  const confirm = useConfirm()
  const [input, setInput] = useState('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const add = async () => {
    if (!input.trim() || !name.trim()) {
      toast('フォルダのURLまたはIDと、表示名の両方を入力してください', 'error')
      return
    }
    setSaving(true)
    try {
      await apiFetch('/api/admin/doc-folders', {
        method: 'POST',
        body: JSON.stringify({ drive_folder_id: input.trim(), drive_folder_name: name.trim() }),
      })
      setInput('')
      setName('')
      await mutate()
      toast('フォルダを追加しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '追加に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (folder: DocFolder) => {
    const ok = await confirm({
      title: 'フォルダを削除',
      message:
        folder.channel_count > 0
          ? `「${folder.drive_folder_name}」を削除しますか？ ${folder.channel_count}件のチャンネルの参照範囲設定からも同時に外れます。`
          : `「${folder.drive_folder_name}」を削除しますか？`,
      confirmLabel: '削除する',
      danger: true,
    })
    if (!ok) return
    try {
      await apiFetch(`/api/admin/doc-folders/${folder.id}`, { method: 'DELETE' })
      await mutate()
      toast('フォルダを削除しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '削除に失敗しました', 'error')
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-none border-b border-line bg-surface px-7 py-4">
        <Link to="/" className="text-xs text-accent-700 hover:underline">
          ← ワークスペースに戻る
        </Link>
        <div className="mt-1 flex items-baseline gap-1">
          <span className="text-[16px] font-bold text-ink">ドキュメント参照範囲</span>
        </div>
        <p className="mt-1.5 max-w-[640px] text-[12.5px] leading-relaxed text-ink-muted">
          チャンネルAIが回答の根拠として参照できるGoogleドライブのフォルダ候補を登録します（F-22）。各チャンネルは登録済みの候補の中から使用する範囲を「チャンネル設定」の「参照ドキュメント範囲」タブで選びます。
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-5">
        <ul className="mb-6 max-w-[640px] space-y-2">
          {folders.length === 0 && <p className="text-[12px] text-ink-subtle">登録済みのフォルダはありません。</p>}
          {folders.map((f) => (
            <li key={f.id} className="flex items-center gap-2.5 rounded-[10px] border border-line px-3.5 py-2.5">
              <span className="text-base">📁</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-ink">{f.drive_folder_name}</div>
                <div className="truncate text-[11px] text-ink-subtle">
                  {f.drive_folder_id} ・ 登録: {f.added_by_name} ・ 使用中のチャンネル {f.channel_count}件
                </div>
              </div>
              <button
                type="button"
                onClick={() => remove(f)}
                className="flex-none rounded-md border border-line-strong px-2.5 py-1 text-[11.5px] font-semibold text-danger-text hover:border-danger-border hover:bg-danger-bg"
              >
                削除
              </button>
            </li>
          ))}
        </ul>

        <div className="max-w-[640px] rounded-[10px] border border-dashed border-line-strong bg-surface-subtle px-4 py-4">
          <div className="mb-3.5 text-[12.5px] font-bold text-ink">＋ 新しいフォルダを追加</div>
          <div className="mb-3.5">
            <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">
              GoogleドライブのフォルダURLまたはID
            </label>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="https://drive.google.com/drive/folders/..."
              className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
            />
            <div className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">
              このスライスはURL・IDの手動入力のみに対応します（Googleドライブのフォルダ選択画面からの選択は、Drive連携拡張とあわせて次のスライスで対応予定です）。
            </div>
          </div>
          <div className="mb-3.5">
            <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">表示名</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 開発部 ドキュメント"
              maxLength={200}
              className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={add}
              className="rounded-lg bg-accent-600 px-4 py-2 text-[13px] font-bold text-white disabled:opacity-40"
            >
              ＋ フォルダを追加
            </button>
            <button
              type="button"
              disabled
              title="索引・AI検索は次のスライスで実装予定です"
              className="rounded-lg border border-line-strong px-4 py-2 text-[13px] font-semibold text-ink-subtle opacity-50"
            >
              今すぐ同期
            </button>
          </div>
          <div className="mt-2 text-[11px] leading-relaxed text-ink-subtle">
            「今すぐ同期」は実際のDrive同期・文書の索引化・チャンネルAIからの検索を行うボタンですが、このスライスでは未実装です（次のスライスで対応予定）。
          </div>
        </div>
      </div>
    </div>
  )
}

// A-42/A-43: AI利用状況・コストタブ本体（F-29）。基本設計書8.6節「T-13を月次・チャンネル別・
// 利用者別に集計して表示する」のとおりチャンネル別・利用者別の内訳テーブルを表示する。上限設定は
// 全体（scope='global'）のみこのスライスで編集UIを設け、チャンネル別上限（scope='channel'）は
// バックエンドは対応済みだが編集UIは対象外とした（既存の値があれば参考表示のみ）。80%到達時の
// 通知メール送信・上限到達時の応答停止は未実装（上限到達時の挙動は要件定義書8.2節のとおり
// 千田氏との別途協議事項のため、このスライスは設定の保存とused_pct表示のみ行う）
function UsageTab() {
  const [month, setMonth] = useState(currentMonthStr)
  const { usage, mutate } = useUsageStats(month)

  return (
    <div className="flex h-full flex-col">
      <div className="flex-none border-b border-line bg-surface px-7 py-4">
        <Link to="/" className="text-xs text-accent-700 hover:underline">
          ← ワークスペースに戻る
        </Link>
        <div className="mt-1 flex items-center gap-2.5">
          <span className="text-[16px] font-bold text-ink">AI利用状況・コスト</span>
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value || currentMonthStr())}
            className="ml-auto rounded-lg border border-line-strong px-2.5 py-1 text-[12.5px] text-ink outline-none focus:border-accent-600"
          />
        </div>
        <p className="mt-1.5 max-w-[640px] text-[12.5px] leading-relaxed text-ink-muted">
          チャンネルAIの呼び出し件数・トークン数・概算コストを月次で集計します（F-29）。質問文・回答文そのものは記録していません。
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-5">
        {!usage ? <p className="text-sm text-ink-subtle">読み込み中...</p> : <UsageTabBody usage={usage} mutate={mutate} />}
      </div>
    </div>
  )
}

function UsageTabBody({ usage, mutate }: { usage: UsageStats; mutate: () => Promise<unknown> }) {
  return (
    <div className="max-w-[820px]">
      <div className="mb-5 flex gap-3">
        <div className="flex-1 rounded-[10px] border border-line px-4 py-3">
          <div className="text-[11px] font-bold text-ink-subtle">概算コスト合計</div>
          <div className="mt-1 text-xl font-bold text-ink">{formatYen(usage.total_cost_yen)}</div>
        </div>
        <div className="flex-1 rounded-[10px] border border-line px-4 py-3">
          <div className="text-[11px] font-bold text-ink-subtle">呼び出し件数</div>
          <div className="mt-1 text-xl font-bold text-ink">{usage.total_call_count.toLocaleString('ja-JP')}件</div>
        </div>
      </div>

      <div className="mb-6">
        <div className="mb-1.5 text-[12.5px] font-bold text-ink">チャンネル別</div>
        <table className="w-full border-collapse text-left text-[12.5px]">
          <thead>
            <tr>
              {['チャンネル', '呼び出し件数', '入力トークン', '出力トークン', '概算コスト'].map((h) => (
                <th key={h} className="border-b border-line-strong px-2.5 py-1.5 text-[11px] font-bold text-ink-subtle">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {usage.by_channel.map((r) => (
              <tr key={r.channel_id} className="border-b border-line">
                <td className="px-2.5 py-2 font-semibold text-ink"># {r.channel_name ?? '(削除済み)'}</td>
                <td className="px-2.5 py-2 text-ink-muted">{r.call_count.toLocaleString('ja-JP')}</td>
                <td className="px-2.5 py-2 text-ink-muted">{r.input_tokens.toLocaleString('ja-JP')}</td>
                <td className="px-2.5 py-2 text-ink-muted">{r.output_tokens.toLocaleString('ja-JP')}</td>
                <td className="px-2.5 py-2 font-semibold text-ink">{formatYen(r.cost_yen)}</td>
              </tr>
            ))}
            {usage.by_channel.length === 0 && (
              <tr>
                <td colSpan={5} className="px-2.5 py-6 text-center text-ink-subtle">
                  この月の利用はありません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mb-6">
        <div className="mb-1.5 text-[12.5px] font-bold text-ink">利用者別</div>
        <table className="w-full border-collapse text-left text-[12.5px]">
          <thead>
            <tr>
              {['利用者', '呼び出し件数', '入力トークン', '出力トークン', '概算コスト'].map((h) => (
                <th key={h} className="border-b border-line-strong px-2.5 py-1.5 text-[11px] font-bold text-ink-subtle">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {usage.by_user.map((r) => (
              <tr key={r.user_id} className="border-b border-line">
                <td className="px-2.5 py-2 font-semibold text-ink">{r.user_name}</td>
                <td className="px-2.5 py-2 text-ink-muted">{r.call_count.toLocaleString('ja-JP')}</td>
                <td className="px-2.5 py-2 text-ink-muted">{r.input_tokens.toLocaleString('ja-JP')}</td>
                <td className="px-2.5 py-2 text-ink-muted">{r.output_tokens.toLocaleString('ja-JP')}</td>
                <td className="px-2.5 py-2 font-semibold text-ink">{formatYen(r.cost_yen)}</td>
              </tr>
            ))}
            {usage.by_user.length === 0 && (
              <tr>
                <td colSpan={5} className="px-2.5 py-6 text-center text-ink-subtle">
                  この月の利用はありません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {usage.limits.channels.length > 0 && (
        <div className="mb-6">
          <div className="mb-1.5 text-[12.5px] font-bold text-ink">チャンネル別上限（参考表示）</div>
          <ul className="space-y-1.5">
            {usage.limits.channels.map((l) => (
              <li key={l.channel_id} className="rounded-[8px] border border-line px-3 py-2 text-[12px] text-ink-muted">
                # {l.channel_name ?? '(削除済み)'}: {formatYen(l.monthly_limit_yen)} 中 {l.used_pct}% 使用（通知先: {l.notify_email}）
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-ink-subtle">
            チャンネル別上限の追加・編集UIはこのスライスでは対象外です（バックエンドAPIは対応済み）。
          </p>
        </div>
      )}

      <GlobalLimitForm limit={usage.limits.global} mutate={mutate} />
    </div>
  )
}

function GlobalLimitForm({ limit, mutate }: { limit: UsageLimit | null; mutate: () => Promise<unknown> }) {
  const toast = useToast()
  const [limitYen, setLimitYen] = useState(limit ? String(limit.monthly_limit_yen) : '')
  const [thresholdPct, setThresholdPct] = useState(limit ? String(limit.notify_threshold_pct) : '80')
  const [notifyEmail, setNotifyEmail] = useState(limit?.notify_email ?? '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const yen = Number(limitYen)
    if (!yen || yen <= 0) {
      toast('上限額は0より大きい数値で入力してください', 'error')
      return
    }
    if (!notifyEmail.trim()) {
      toast('通知先メールアドレスを入力してください', 'error')
      return
    }
    setSaving(true)
    try {
      await apiFetch('/api/admin/usage/limits', {
        method: 'PUT',
        body: JSON.stringify({
          scope: 'global',
          monthly_limit_yen: yen,
          notify_threshold_pct: Number(thresholdPct) || 80,
          notify_email: notifyEmail.trim(),
        }),
      })
      await mutate()
      toast('上限設定を保存しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-[420px] rounded-[10px] border border-line-strong bg-surface-subtle px-4 py-4">
      <div className="mb-3.5 text-[12.5px] font-bold text-ink">全体の上限設定</div>
      {limit && (
        <div className="mb-3.5">
          <div className="mb-1 flex justify-between text-[11px] text-ink-subtle">
            <span>今月の使用率</span>
            <span>{limit.used_pct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
            <div
              className={`h-full rounded-full ${limit.used_pct >= 100 ? 'bg-danger-text' : limit.used_pct >= limit.notify_threshold_pct ? 'bg-off-text' : 'bg-accent-600'}`}
              style={{ width: `${Math.min(limit.used_pct, 100)}%` }}
            />
          </div>
        </div>
      )}
      <div className="mb-3.5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">月次上限額（円）</label>
        <input
          type="number"
          min="1"
          value={limitYen}
          onChange={(e) => setLimitYen(e.target.value)}
          placeholder="例: 20000"
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>
      <div className="mb-3.5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">通知しきい値（%）</label>
        <input
          type="number"
          min="1"
          max="100"
          value={thresholdPct}
          onChange={(e) => setThresholdPct(e.target.value)}
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>
      <div className="mb-3.5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">通知先メールアドレス</label>
        <input
          value={notifyEmail}
          onChange={(e) => setNotifyEmail(e.target.value)}
          placeholder="admin@kogasoftware.com"
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>
      <div className="mb-3.5 text-[11px] leading-relaxed text-ink-subtle">
        しきい値到達時の通知メール送信・上限到達時の応答停止は未実装です（挙動は別途協議事項のため、現時点では使用率の表示のみ行います）。
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={save}
        className="rounded-lg bg-accent-600 px-4 py-2 text-[13px] font-bold text-white disabled:opacity-40"
      >
        保存
      </button>
    </div>
  )
}

const EVENT_TYPE_LABEL: Record<string, string> = { login: 'ログイン', channel_ai_setting_change: 'チャンネルAI設定変更' }

// A-44: 監査ログタブ本体（要件定義書7章「監査」）。種別・実行者・期間で絞り込む。対象チャンネルでの
// 絞り込みはバックエンドは対応済み（channel_id）だが、全チャンネル一覧を返す管理者向けAPIが無いため
// このスライスでは選択式の絞り込みUIは設けず、一覧の「対象」列に表示するのみに留めた。
function AuditLogTab() {
  const { users } = useAdminUsers()
  const [eventType, setEventType] = useState('')
  const [actorUserId, setActorUserId] = useState('')
  const [after, setAfter] = useState('')
  const [before, setBefore] = useState('')
  const { logs, hasMore } = useAuditLogs({
    event_type: eventType || undefined,
    actor_user_id: actorUserId || undefined,
    after: after || undefined,
    before: before || undefined,
  })

  return (
    <div className="flex h-full flex-col">
      <div className="flex-none border-b border-line bg-surface px-7 py-4">
        <Link to="/" className="text-xs text-accent-700 hover:underline">
          ← ワークスペースに戻る
        </Link>
        <div className="mt-1 text-[16px] font-bold text-ink">監査ログ</div>
        <p className="mt-1.5 max-w-[640px] text-[12.5px] leading-relaxed text-ink-muted">
          ログイン・チャンネルAI設定の変更を記録します（要件定義書7章）。いつ・誰が・どの項目を変更したかのみを記録し、変更内容そのもの（差分）は保持しません。
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-5">
        <div className="mb-3.5 flex flex-wrap items-center gap-2">
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            className="rounded-lg border border-line-strong px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent-600"
          >
            <option value="">すべての種別</option>
            <option value="login">ログイン</option>
            <option value="channel_ai_setting_change">チャンネルAI設定変更</option>
          </select>
          <select
            value={actorUserId}
            onChange={(e) => setActorUserId(e.target.value)}
            className="rounded-lg border border-line-strong px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-accent-600"
          >
            <option value="">すべての実行者</option>
            {users.map((u: AdminUser) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">
            期間
            <input
              type="date"
              value={after}
              onChange={(e) => setAfter(e.target.value)}
              className="rounded-lg border border-line-strong px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent-600"
            />
            〜
            <input
              type="date"
              value={before}
              onChange={(e) => setBefore(e.target.value)}
              className="rounded-lg border border-line-strong px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent-600"
            />
          </label>
        </div>

        <table className="w-full border-collapse text-left text-[12.5px]">
          <thead>
            <tr>
              {['日時', '種別', '対象', '実行者', '詳細'].map((h) => (
                <th key={h} className="border-b border-line-strong px-2.5 py-1.5 text-[11px] font-bold text-ink-subtle">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id} className="border-b border-line">
                <td className="whitespace-nowrap px-2.5 py-2 text-ink-subtle">{formatDateTime(l.created_at)}</td>
                <td className="px-2.5 py-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10.5px] font-bold ${
                      l.event_type === 'login' ? 'bg-member-bg text-member-text' : 'bg-accent-50 text-accent-700'
                    }`}
                  >
                    {EVENT_TYPE_LABEL[l.event_type] ?? l.event_type}
                  </span>
                </td>
                <td className="px-2.5 py-2 text-ink-muted">{l.target_channel_name ? `# ${l.target_channel_name}` : '—'}</td>
                <td className="px-2.5 py-2 font-semibold text-ink">{l.actor_name}</td>
                <td className="px-2.5 py-2 text-ink-muted">{l.summary}</td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colSpan={5} className="px-2.5 py-8 text-center text-ink-subtle">
                  該当する記録がありません。
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {hasMore && (
          <p className="mt-3 text-center text-[11px] text-ink-subtle">
            50件まで表示しています。絞り込み条件を指定すると対象を絞り込めます。
          </p>
        )}
      </div>
    </div>
  )
}
