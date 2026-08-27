import { useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useChannel } from '../hooks/useChannels'
import { useChannelMembers } from '../hooks/useChannelMembers'
import { useMe } from '../hooks/useMe'
import { apiFetch, ApiError } from '../lib/api'
import { avatarColorFor } from '../lib/avatarColor'
import { useToast } from '../components/Toast'
import { useConfirm } from '../components/ui/ConfirmDialog'

// S-06 チャンネル設定（このスライスは「チャンネル管理者」タブのみ実装。定期投稿・自動応答トリガー・
// AI設定7タブはスケジューラ・AIエンジンが未実装のため対象外。CLAUDE.md 実装状況節）
export default function ChannelSettings() {
  const { channelId } = useParams<{ channelId: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const { me } = useMe()
  const { channel, error: channelError, mutate: mutateChannel } = useChannel(channelId)
  const { members, mutate: mutateMembers } = useChannelMembers(channelId)

  useEffect(() => {
    // 総論5.9節: 非公開チャンネルの非参加者はワークスペースへ無言で戻す。
    // 参加しているがchadminでない場合はS-03へトースト通知付きで戻す（基本設計書4.2節「設計判断」）
    if (channelError instanceof ApiError && (channelError.status === 404 || channelError.status === 403)) {
      navigate('/', { replace: true })
      return
    }
    if (channel && me && !channel.is_channel_admin && me.role !== 'admin') {
      navigate(`/channels/${channelId}`, { replace: true })
      toast('このページを表示する権限がありません', 'info')
    }
  }, [channel, channelError, me])

  const admins = members.filter((m) => m.is_channel_admin)
  const others = members.filter((m) => !m.is_channel_admin)
  const adminCount = admins.length

  const addAdmin = async (userId: string) => {
    try {
      await apiFetch(`/api/channels/${channelId}/admins`, {
        method: 'POST',
        body: JSON.stringify({ user_id: userId }),
      })
      await mutateMembers()
      toast('管理者に追加しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '追加に失敗しました', 'error')
    }
  }

  const removeAdmin = async (userId: string, name: string) => {
    const ok = await confirm({
      title: '管理者を解除',
      message: `${name} さんをこのチャンネルの管理者から解除しますか？`,
      confirmLabel: '解除する',
      danger: true,
    })
    if (!ok) return
    try {
      await apiFetch(`/api/channels/${channelId}/admins/${userId}`, { method: 'DELETE' })
      await mutateMembers()
      toast('管理者を解除しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '解除に失敗しました', 'error')
    }
  }

  const toggleVisibility = async () => {
    if (!channel) return
    const nextIsPublic = !channel.is_public
    try {
      await apiFetch(`/api/channels/${channelId}/visibility`, {
        method: 'PUT',
        body: JSON.stringify({ is_public: nextIsPublic }),
      })
      await mutateChannel()
      toast(nextIsPublic ? '公開チャンネルにしました' : '非公開チャンネルにしました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '変更に失敗しました', 'error')
    }
  }

  const isPrivateOn = channel ? !channel.is_public : false

  return (
    <div className="flex h-full flex-col">
      <div className="flex-none border-b border-line bg-surface px-7 py-3.5">
        <Link to={`/channels/${channelId}`} className="text-xs text-accent-700 hover:underline">
          ← # {channel?.name ?? ''} に戻る
        </Link>
        <div className="mt-1 text-[15px] font-bold text-ink">チャンネル設定</div>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-5.5">
        <div className="max-w-[700px]">
          <p className="mb-5 text-[12.5px] leading-relaxed text-ink-muted">
            このチャンネルの管理者（chadmin）を設定します。チャンネル管理者はチャンネル設定の編集と、
            対応できない依頼の引き継ぎ先になります。
          </p>

          <div className="mb-5.5">
            <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">公開範囲</label>
            <label className="flex cursor-pointer items-center gap-3 rounded-[10px] border border-line bg-surface-subtle px-3.5 py-3">
              <span
                className={`relative h-[22px] w-[38px] flex-none rounded-full transition-colors ${
                  isPrivateOn ? 'bg-accent-600' : 'bg-line-strong'
                }`}
              >
                <input type="checkbox" checked={isPrivateOn} onChange={toggleVisibility} className="sr-only" />
                <span
                  className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${
                    isPrivateOn ? 'left-[18px]' : 'left-0.5'
                  }`}
                />
              </span>
              <span>
                <div className="text-[13px] font-bold text-ink">このチャンネルを非公開にする</div>
                <div className="mt-0.5 text-[11.5px] text-ink-subtle">
                  オンにすると、参加者以外には一覧・検索に表示されなくなります。参加には既存の参加者による追加が必要になります。
                </div>
              </span>
            </label>
          </div>

          <div className="mb-5.5">
            <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">現在のチャンネル管理者</label>
            <p className="mb-2.5 text-[11.5px] leading-relaxed text-ink-subtle">
              複数人指定できます。最後の1人は解除できません（管理者不在の防止）。
            </p>
            <ul className="space-y-2">
              {admins.map((m) => (
                <li key={m.id} className="flex items-center gap-2.5">
                  <span
                    className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full text-[11px] font-bold text-white"
                    style={{ background: avatarColorFor(m.id) }}
                  >
                    {m.name.slice(0, 1)}
                  </span>
                  <span className="text-[13px] font-semibold text-ink">{m.name}</span>
                  <span className="rounded bg-chadmin-bg px-1.5 py-0.5 text-[10px] font-bold text-chadmin-text">
                    chadmin
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAdmin(m.id, m.name)}
                    disabled={adminCount <= 1}
                    className="ml-auto rounded-md border border-accent-100 bg-accent-50 px-3 py-1 text-xs font-semibold text-accent-700 hover:bg-accent-100 disabled:opacity-30"
                  >
                    解除
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">管理者に追加</label>
            {others.length === 0 ? (
              <p className="text-[11.5px] text-ink-subtle">追加できる参加者はいません。</p>
            ) : (
              <ul className="space-y-2">
                {others.map((m) => (
                  <li key={m.id} className="flex items-center gap-2.5">
                    <span
                      className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-full text-[11px] font-bold text-white"
                      style={{ background: avatarColorFor(m.id) }}
                    >
                      {m.name.slice(0, 1)}
                    </span>
                    <span className="text-[13px] font-semibold text-ink">{m.name}</span>
                    <button
                      type="button"
                      onClick={() => addAdmin(m.id)}
                      className="ml-auto rounded-md border border-line-strong px-3 py-1 text-xs font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700"
                    >
                      追加
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-subtle">
              追加できるのはこのチャンネルの参加者のみです。システム管理者は全チャンネルの設定を編集できるため、ここへの追加は不要です。
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
