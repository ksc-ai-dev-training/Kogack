import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useChannel, useChannels } from '../hooks/useChannels'
import { useChannelMembers } from '../hooks/useChannelMembers'
import { useAiSettings } from '../hooks/useAiSettings'
import { useRecurringPosts } from '../hooks/useRecurringPosts'
import { useTriggerRules } from '../hooks/useTriggerRules'
import { useMe } from '../hooks/useMe'
import { apiFetch, ApiError, uploadIcon } from '../lib/api'
import { avatarColorFor } from '../lib/avatarColor'
import { useToast } from '../components/Toast'
import { useConfirm } from '../components/ui/ConfirmDialog'
import type { AiSettings, ChannelDetail, RecurringPost, TriggerRule } from '../types'

const ICON_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_ICON_BYTES = 5 * 1024 * 1024

// S-06 チャンネル設定。このスライスは6タブ（チャンネル管理者・基本設定・キャラクタ・振る舞い定義・
// 定期投稿・自動応答トリガー）を実装。「参照ドキュメント範囲」「スキル」「反応モード」「自動対応範囲」
// タブはドキュメントQ&A・自動対応分類が未実装のため対象外（CLAUDE.md 実装状況節）。
// タブ切替はLayout.tsxと共有する?tab=クエリパラメータで行う。
export default function ChannelSettings() {
  const { channelId } = useParams<{ channelId: string }>()
  const [searchParams] = useSearchParams()
  const tab = searchParams.get('tab') ?? 'admin'
  const navigate = useNavigate()
  const toast = useToast()
  const { me } = useMe()
  const { channel, error: channelError } = useChannel(channelId)
  const { settings, mutate: mutateAi } = useAiSettings(channelId)

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

  return (
    <div className="flex h-full flex-col">
      <div className="flex-none border-b border-line bg-surface px-7 py-3.5">
        <Link to={`/channels/${channelId}`} className="text-xs text-accent-700 hover:underline">
          ← # {channel?.name ?? ''} に戻る
        </Link>
        <div className="mt-1 text-[15px] font-bold text-ink">チャンネル設定</div>
      </div>

      <div className="flex-1 overflow-y-auto px-7 py-5.5">
        {tab === 'general' && channelId && settings && (
          <GeneralTab channelId={channelId} channelName={channel?.name ?? ''} settings={settings} mutate={mutateAi} />
        )}
        {tab === 'character' && channelId && settings && (
          <CharacterTab channelId={channelId} settings={settings} mutate={mutateAi} />
        )}
        {tab === 'prompt' && channelId && settings && (
          <PromptTab channelId={channelId} settings={settings} mutate={mutateAi} />
        )}
        {tab === 'admin' && channelId && <AdminTab channelId={channelId} />}
        {tab === 'recurring' && channelId && <RecurringPostsTab channelId={channelId} />}
        {tab === 'trigger' && channelId && <TriggerRulesTab channelId={channelId} />}
      </div>
    </div>
  )
}

// A-71: チャンネル名・説明（トピック）の編集。設計書には以前無かった機能のため今回追加した
// （基本設計書・詳細設計書API設計・画面モックアップを同じコミットで改訂）。channelを非nullで
// 受け取ってから一度だけマウントすることで、ロード完了前のuseStateへ初期値を渡す問題を避ける
// （ProfileEditModal等と同じ考え方）
function ChannelInfoForm({
  channelId,
  channel,
  onSaved,
}: {
  channelId: string
  channel: ChannelDetail
  onSaved: () => Promise<unknown>
}) {
  const toast = useToast()
  const [name, setName] = useState(channel.name)
  const [topic, setTopic] = useState(channel.topic ?? '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast('チャンネル名を入力してください', 'error')
      return
    }
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: trimmed, topic: topic.trim() }),
      })
      await onSaved()
      toast('チャンネル情報を更新しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '更新に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="mb-5.5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">チャンネル名</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={256}
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>

      <div className="mb-3">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">説明（任意）</label>
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="このチャンネルの目的を入力"
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-subtle focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={save}
        className="mb-5.5 rounded-lg bg-accent-600 px-4 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-40"
      >
        保存
      </button>
    </>
  )
}

function AdminTab({ channelId }: { channelId: string }) {
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const { channel, mutate: mutateChannel } = useChannel(channelId)
  const { members, mutate: mutateMembers } = useChannelMembers(channelId)
  const { mutate: mutateChannelsList } = useChannels()
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)

  const admins = members.filter((m) => m.is_channel_admin)
  const others = members.filter((m) => !m.is_channel_admin)
  const adminCount = admins.length

  const deleteChannel = async () => {
    if (!channel || deleteConfirmText !== channel.name) return
    const ok = await confirm({
      title: 'チャンネルを削除',
      message: `# ${channel.name} を削除しますか？\n会話ログ・スレッド・送信予約・AI設定を含め、このチャンネルのすべてのデータが完全に削除されます。この操作は取り消せません。`,
      confirmLabel: '完全に削除する',
      danger: true,
    })
    if (!ok) return
    setDeleting(true)
    try {
      await apiFetch(`/api/channels/${channelId}`, { method: 'DELETE' })
      await mutateChannelsList()
      toast('チャンネルを削除しました')
      navigate('/', { replace: true })
    } catch (e) {
      toast(e instanceof Error ? e.message : '削除に失敗しました', 'error')
      setDeleting(false)
    }
  }

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
    <div className="max-w-[700px]">
      <p className="mb-5 text-[12.5px] leading-relaxed text-ink-muted">
        このチャンネルの管理者（chadmin）を設定します。チャンネル管理者はチャンネル設定の編集と、
        対応できない依頼の引き継ぎ先になります。
      </p>

      {channel && (
        <ChannelInfoForm
          channelId={channelId}
          channel={channel}
          onSaved={() => Promise.all([mutateChannel(), mutateChannelsList()])}
        />
      )}

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

      {channel && (
        <div className="mt-8 rounded-[10px] border border-danger-border bg-danger-bg px-4 py-4">
          <label className="mb-1.5 block text-[12.5px] font-bold text-danger-text">チャンネルを削除</label>
          <p className="mb-3 text-[11.5px] leading-relaxed text-ink-muted">
            会話ログ・スレッド・送信予約・AI設定を含め、このチャンネルのすべてのデータが完全に削除されます。この操作は取り消せません。削除するには、チャンネル名「{channel.name}」を下に入力してください。
          </p>
          <div className="flex gap-2">
            <input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={channel.name}
              className="w-full max-w-[280px] rounded-lg border border-line-strong px-3 py-1.5 text-[13px] text-ink outline-none focus:border-danger-text focus:ring-4 focus:ring-danger-bg"
            />
            <button
              type="button"
              disabled={deleteConfirmText !== channel.name || deleting}
              onClick={deleteChannel}
              className="flex-none rounded-lg bg-danger-text px-4 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-30"
            >
              削除する
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// 基本設定タブ（A-24、F-08）。反応モードの編集UIはこのスライスでは対象外（常にメンション時のみ応答）
function GeneralTab({
  channelId,
  channelName,
  settings,
  mutate,
}: {
  channelId: string
  channelName: string
  settings: AiSettings
  mutate: () => Promise<AiSettings | undefined>
}) {
  const toast = useToast()
  const [saving, setSaving] = useState(false)

  const toggle = async () => {
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/ai-settings/general`, {
        method: 'PUT',
        body: JSON.stringify({ is_ai_enabled: !settings.is_ai_enabled }),
      })
      await mutate()
      toast(settings.is_ai_enabled ? 'AIを無効にしました' : 'AIを有効にしました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '変更に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-[700px]">
      <p className="mb-5 text-[12.5px] leading-relaxed text-ink-muted">
        このチャンネルでのAIの有効/無効を切り替えます。AIを置かないチャンネル（雑談など）があってもかまいません。
      </p>
      <label className="flex cursor-pointer items-center gap-3 rounded-[10px] border border-line bg-surface-subtle px-3.5 py-3">
        <span
          className={`relative h-[22px] w-[38px] flex-none rounded-full transition-colors ${
            settings.is_ai_enabled ? 'bg-accent-600' : 'bg-line-strong'
          }`}
        >
          <input
            type="checkbox"
            checked={settings.is_ai_enabled}
            onChange={toggle}
            disabled={saving}
            className="sr-only"
          />
          <span
            className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${
              settings.is_ai_enabled ? 'left-[18px]' : 'left-0.5'
            }`}
          />
        </span>
        <span>
          <div className="text-[13px] font-bold text-ink"># {channelName} でAIを有効にする</div>
          <div className="mt-0.5 text-[11.5px] text-ink-subtle">
            無効にすると、このチャンネルでメンションしてもAIは応答しません。
          </div>
        </span>
      </label>
    </div>
  )
}

// キャラクタタブ（A-25、F-10）。アイコンはA-61アップロード→A-25保存の順（補足06と同じ流れ）
function CharacterTab({
  channelId,
  settings,
  mutate,
}: {
  channelId: string
  settings: AiSettings
  mutate: () => Promise<AiSettings | undefined>
}) {
  const toast = useToast()
  const [name, setName] = useState(settings.persona_name ?? 'AI')
  const [tone, setTone] = useState(settings.persona_tone ?? '')
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const pickFile = (f: File | null) => {
    if (!f) return
    if (!ICON_TYPES.includes(f.type)) {
      toast('JPEG・PNG・WebP形式のみアップロードできます', 'error')
      return
    }
    if (f.size > MAX_ICON_BYTES) {
      toast('ファイルサイズは5MBまでです', 'error')
      return
    }
    setFile(f)
  }

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast('名前を入力してください', 'error')
      return
    }
    setSaving(true)
    try {
      const iconUrl = file ? (await uploadIcon(file)).url : settings.persona_icon_url
      await apiFetch(`/api/channels/${channelId}/ai-settings/character`, {
        method: 'PUT',
        body: JSON.stringify({
          persona_name: trimmed,
          persona_icon_url: iconUrl,
          persona_tone: tone.trim() || null,
        }),
      })
      await mutate()
      setFile(null)
      toast('キャラクタを更新しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '更新に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-[700px]">
      <p className="mb-5 text-[12.5px] leading-relaxed text-ink-muted">AIの名前・アイコン・口調を設定します（F-10）。</p>

      <div className="mb-5 flex items-center gap-4">
        {previewUrl ? (
          <img src={previewUrl} alt="" className="h-14 w-14 flex-none rounded-[12px] object-cover" />
        ) : settings.persona_icon_url ? (
          <img src={settings.persona_icon_url} alt="" className="h-14 w-14 flex-none rounded-[12px] object-cover" />
        ) : (
          <div className="flex h-14 w-14 flex-none items-center justify-center rounded-[12px] bg-gradient-to-br from-accent-600 to-accent-700 text-sm font-bold text-white">
            AI
          </div>
        )}
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg border border-line-strong px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700"
          >
            画像をアップロード
          </button>
          <div className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">
            JPEG・PNG・WebP、5MBまで。未設定の間は「AI」の2文字で表示されます。
          </div>
        </div>
      </div>

      <div className="mb-5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">名前</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>

      <div className="mb-5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">口調</label>
        <textarea
          value={tone}
          onChange={(e) => setTone(e.target.value)}
          rows={3}
          maxLength={500}
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] leading-relaxed text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
        <div className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">
          この口調の指定は、次の「振る舞い定義」の内容と合わせてAIの応答生成に反映されます。
        </div>
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

// 振る舞い定義タブ（A-26、F-09）。上書き保存のみで過去バージョンは持たない。監査ログ（T-16）は
// S-08監査ログタブと同様に未実装のため記録しない旨をヒントに明記する
function PromptTab({
  channelId,
  settings,
  mutate,
}: {
  channelId: string
  settings: AiSettings
  mutate: () => Promise<AiSettings | undefined>
}) {
  const toast = useToast()
  const [prompt, setPrompt] = useState(settings.behavior_prompt ?? '')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/ai-settings/prompt`, {
        method: 'PUT',
        body: JSON.stringify({ behavior_prompt: prompt }),
      })
      await mutate()
      toast('振る舞い定義を更新しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '更新に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-[700px]">
      <p className="mb-5 text-[12.5px] leading-relaxed text-ink-muted">AIの振る舞いをテキスト（プロンプト）で記述します（F-09）。</p>
      <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">振る舞い定義</label>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={10}
        maxLength={8000}
        className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] leading-relaxed text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
      />
      <div className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">
        編集のたびに上書き保存されます（過去バージョンの一覧・差分表示は対象外）。
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={save}
        className="mt-4 rounded-lg bg-accent-600 px-4 py-2 text-[13px] font-bold text-white disabled:opacity-40"
      >
        保存
      </button>
    </div>
  )
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

// F-36/F-38共通の「送り主のアイコン」入力（画面モックアップS-06）。絵文字を直接入力するか、
// 画像をアップロードする（アップロードした画像が優先表示される、F-37）。
function IconInput({
  emoji,
  onEmojiChange,
  iconUrl,
  onIconUrlChange,
}: {
  emoji: string
  onEmojiChange: (v: string) => void
  iconUrl: string | null
  onIconUrlChange: (v: string | null) => void
}) {
  const toast = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const pickFile = async (f: File | null) => {
    if (!f) return
    if (!ICON_TYPES.includes(f.type)) {
      toast('JPEG・PNG・WebP形式のみアップロードできます', 'error')
      return
    }
    if (f.size > MAX_ICON_BYTES) {
      toast('ファイルサイズは5MBまでです', 'error')
      return
    }
    try {
      const { url } = await uploadIcon(f)
      onIconUrlChange(url)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'アップロードに失敗しました', 'error')
    }
  }

  return (
    <div className="mb-5">
      <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">送り主のアイコン</label>
      <div className="flex items-center gap-2">
        {iconUrl ? (
          <img src={iconUrl} alt="" className="h-8 w-8 flex-none rounded-[8px] object-cover" />
        ) : (
          <div className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] bg-bot-bg text-base">
            {emoji || '📌'}
          </div>
        )}
        <input
          value={emoji}
          onChange={(e) => {
            onEmojiChange(e.target.value)
            onIconUrlChange(null)
          }}
          maxLength={8}
          placeholder="絵文字"
          className="w-24 rounded-lg border border-line-strong px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="rounded-lg border border-line-strong px-3 py-1.5 text-[12px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700"
        >
          画像をアップロード
        </button>
      </div>
      <div className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">
        絵文字を直接入力するか、画像をアップロードします（アップロードした画像が優先されます）。
      </div>
    </div>
  )
}

function formatRecurringSchedule(item: RecurringPost): string {
  const d = new Date(item.anchor_at)
  const time = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  if (item.frequency === 'once') return `1回のみ ${d.toLocaleDateString('ja-JP')} ${time}`
  if (item.frequency === 'daily') return `毎日 ${time}`
  if (item.frequency === 'weekly') return `毎週 ${WEEKDAYS[d.getDay()]}曜 ${time}`
  return `毎月 ${d.getDate()}日 ${time}`
}

// 「初回の送信日時」欄の既定値（送信予約ComposerのdefaultScheduleDateTimeと同じ考え方で
// 5分後を初期値にし、「未来の日時を指定してください」のバリデーションに即座に引っかからないようにする）
function pad2(n: number) {
  return String(n).padStart(2, '0')
}
function defaultAnchor(): { date: string; time: string } {
  const d = new Date(Date.now() + 5 * 60 * 1000)
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  }
}

// 定期投稿の入力欄（新規作成パネル・編集モーダルの両方から使う共通の見た目）
function RecurringPostFormFields({
  displayName, onDisplayNameChange,
  emoji, onEmojiChange,
  iconUrl, onIconUrlChange,
  body, onBodyChange,
  frequency, onFrequencyChange,
  date, onDateChange,
  time, onTimeChange,
}: {
  displayName: string
  onDisplayNameChange: (v: string) => void
  emoji: string
  onEmojiChange: (v: string) => void
  iconUrl: string | null
  onIconUrlChange: (v: string | null) => void
  body: string
  onBodyChange: (v: string) => void
  frequency: 'once' | 'daily' | 'weekly' | 'monthly'
  onFrequencyChange: (v: 'once' | 'daily' | 'weekly' | 'monthly') => void
  date: string
  onDateChange: (v: string) => void
  time: string
  onTimeChange: (v: string) => void
}) {
  return (
    <>
      <div className="mb-3.5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">送り主の表示名</label>
        <input
          value={displayName}
          onChange={(e) => onDisplayNameChange(e.target.value)}
          placeholder="例: お知らせBot"
          maxLength={100}
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>

      <IconInput emoji={emoji} onEmojiChange={onEmojiChange} iconUrl={iconUrl} onIconUrlChange={onIconUrlChange} />

      <div className="mb-3.5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">メッセージ本文</label>
        <textarea
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="投稿する内容を入力（@でメンション可。ただしAIへの応答は発生しません）"
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] leading-relaxed text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>

      <div className="mb-1 flex gap-3">
        <div className="flex-1">
          <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">頻度</label>
          <select
            value={frequency}
            onChange={(e) => onFrequencyChange(e.target.value as typeof frequency)}
            className="w-full rounded-lg border border-line-strong px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
          >
            <option value="once">1回のみ</option>
            <option value="daily">毎日</option>
            <option value="weekly">毎週</option>
            <option value="monthly">毎月</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">初回の送信日時</label>
          <div className="flex gap-1.5">
            <input
              type="date"
              value={date}
              onChange={(e) => onDateChange(e.target.value)}
              className="w-1/2 rounded-lg border border-line-strong px-2 py-2 text-[12.5px] text-ink outline-none"
            />
            <input
              type="time"
              value={time}
              onChange={(e) => onTimeChange(e.target.value)}
              className="w-1/2 rounded-lg border border-line-strong px-2 py-2 text-[12.5px] text-ink outline-none"
            />
          </div>
        </div>
      </div>
      <div className="mb-3.5 text-[11px] leading-relaxed text-ink-subtle">
        「毎週」は初回日時の曜日、「毎月」は初回日時の日にちで繰り返します（該当日が存在しない月は月末に送信）。「1回のみ」は指定日時に1度だけ投稿し、以降は自動的に一時停止扱いになります。
      </div>
    </>
  )
}

// 定期投稿タブ（A-53〜A-56、F-36）。新規作成は常時表示のパネル、編集は一覧の「編集」から開くモーダルと
// 画面を明確に分けている（同じフォームを使い回すと新規作成と編集の見分けが付きにくいため。ユーザー指摘を受けて改善）
function RecurringPostsTab({ channelId }: { channelId: string }) {
  const toast = useToast()
  const confirm = useConfirm()
  const { items, mutate } = useRecurringPosts(channelId)
  const [editingItem, setEditingItem] = useState<RecurringPost | null>(null)
  const [body, setBody] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [emoji, setEmoji] = useState('📌')
  const [iconUrl, setIconUrl] = useState<string | null>(null)
  const [frequency, setFrequency] = useState<'once' | 'daily' | 'weekly' | 'monthly'>('weekly')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [saving, setSaving] = useState(false)

  const resetForm = () => {
    setBody('')
    setDisplayName('')
    setEmoji('📌')
    setIconUrl(null)
    setFrequency('weekly')
    const d = defaultAnchor()
    setDate(d.date)
    setTime(d.time)
  }

  useEffect(() => {
    resetForm()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId])

  const submit = async () => {
    if (!body.trim()) {
      toast('メッセージ本文を入力してください', 'error')
      return
    }
    if (!date || !time) {
      toast('送信日時を指定してください', 'error')
      return
    }
    const anchorAt = new Date(`${date}T${time}:00`)
    if (Number.isNaN(anchorAt.getTime())) {
      toast('送信日時の形式が不正です', 'error')
      return
    }
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/recurring-posts`, {
        method: 'POST',
        body: JSON.stringify({
          body: body.trim(),
          bot_display_name: displayName.trim() || null,
          bot_icon: iconUrl ? null : emoji.trim() || null,
          bot_icon_url: iconUrl,
          frequency,
          anchor_at: anchorAt.toISOString(),
        }),
      })
      toast('定期投稿を追加しました')
      await mutate()
      resetForm()
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (item: RecurringPost) => {
    try {
      await apiFetch(`/api/channels/${channelId}/recurring-posts/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !item.is_active }),
      })
      await mutate()
    } catch (e) {
      toast(e instanceof Error ? e.message : '変更に失敗しました', 'error')
    }
  }

  const remove = async (item: RecurringPost) => {
    const ok = await confirm({
      title: '定期投稿を削除',
      message: `「${item.bot_display_name}」の定期投稿を削除しますか？ 既に送信済みの発言は残ります。`,
      confirmLabel: '削除する',
      danger: true,
    })
    if (!ok) return
    try {
      await apiFetch(`/api/channels/${channelId}/recurring-posts/${item.id}`, { method: 'DELETE' })
      await mutate()
      if (editingItem?.id === item.id) setEditingItem(null)
      toast('定期投稿を削除しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '削除に失敗しました', 'error')
    }
  }

  return (
    <div className="max-w-[700px]">
      <p className="mb-5 text-[12.5px] leading-relaxed text-ink-muted">
        日時・頻度を指定して、このチャンネルに自動でメッセージを投稿します（F-36）。チャンネルAIとは別物で、質問に答えたりはしません。
      </p>

      <ul className="mb-6 space-y-2.5">
        {items.length === 0 && <p className="text-[12px] text-ink-subtle">定期投稿はまだありません。</p>}
        {items.map((item) => (
          <li key={item.id} className="rounded-[10px] border border-line px-3.5 py-3">
            <div className="flex items-center gap-2">
              {item.bot_icon_url ? (
                <img src={item.bot_icon_url} alt="" className="h-6 w-6 flex-none rounded-[7px] object-cover" />
              ) : (
                <span className="flex h-6 w-6 flex-none items-center justify-center rounded-[7px] bg-bot-bg text-[13px]">
                  {item.bot_icon || '📌'}
                </span>
              )}
              <span className="text-[13px] font-bold text-ink">{item.bot_display_name}</span>
              <span className="rounded bg-bot-bg px-1.5 py-0.5 text-[10px] font-bold text-bot-text">BOT</span>
              <span className="ml-auto rounded-md bg-accent-50 px-2 py-0.5 text-[11px] font-semibold text-accent-700">
                {formatRecurringSchedule(item)}
              </span>
            </div>
            <div className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-ink">{item.body}</div>
            <div className="mt-2.5 flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => toggleActive(item)}
                className={`relative h-[18px] w-[32px] flex-none rounded-full transition-colors ${
                  item.is_active ? 'bg-accent-600' : 'bg-line-strong'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-[14px] w-[14px] rounded-full bg-white shadow transition-all ${
                    item.is_active ? 'left-[16px]' : 'left-0.5'
                  }`}
                />
              </button>
              <span className="text-[11.5px] text-ink-subtle">{item.is_active ? '有効' : '一時停止中'}</span>
              <div className="ml-auto flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditingItem(item)}
                  className="rounded-md border border-line-strong px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700"
                >
                  編集
                </button>
                <button
                  type="button"
                  onClick={() => remove(item)}
                  className="rounded-md border border-line-strong px-2.5 py-1 text-[11.5px] font-semibold text-danger-text hover:border-danger-border hover:bg-danger-bg"
                >
                  削除
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="rounded-[10px] border border-dashed border-line-strong bg-surface-subtle px-4 py-4">
        <div className="mb-3.5 text-[12.5px] font-bold text-ink">＋ 新しい定期投稿を追加</div>

        <RecurringPostFormFields
          displayName={displayName}
          onDisplayNameChange={setDisplayName}
          emoji={emoji}
          onEmojiChange={setEmoji}
          iconUrl={iconUrl}
          onIconUrlChange={setIconUrl}
          body={body}
          onBodyChange={setBody}
          frequency={frequency}
          onFrequencyChange={setFrequency}
          date={date}
          onDateChange={setDate}
          time={time}
          onTimeChange={setTime}
        />

        <div className="flex gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={submit}
            className="rounded-lg bg-accent-600 px-4 py-2 text-[13px] font-bold text-white disabled:opacity-40"
          >
            ＋ 定期投稿を追加
          </button>
        </div>
      </div>

      {editingItem && (
        <RecurringPostEditModal
          key={editingItem.id}
          item={editingItem}
          channelId={channelId}
          onClose={() => setEditingItem(null)}
          onSaved={mutate}
        />
      )}
    </div>
  )
}

// 定期投稿の編集モーダル（一覧の「編集」から開く）。新規作成パネルとは別画面にすることで、
// 「今どちらの操作をしているか」を一目で区別できるようにしている
function RecurringPostEditModal({
  item, channelId, onClose, onSaved,
}: {
  item: RecurringPost
  channelId: string
  onClose: () => void
  onSaved: () => Promise<unknown>
}) {
  const toast = useToast()
  const initialAnchor = new Date(item.anchor_at)
  const [body, setBody] = useState(item.body)
  const [displayName, setDisplayName] = useState(item.bot_display_name)
  const [emoji, setEmoji] = useState(item.bot_icon ?? '📌')
  const [iconUrl, setIconUrl] = useState<string | null>(item.bot_icon_url)
  const [frequency, setFrequency] = useState<'once' | 'daily' | 'weekly' | 'monthly'>(item.frequency)
  const [date, setDate] = useState(`${initialAnchor.getFullYear()}-${pad2(initialAnchor.getMonth() + 1)}-${pad2(initialAnchor.getDate())}`)
  const [time, setTime] = useState(`${pad2(initialAnchor.getHours())}:${pad2(initialAnchor.getMinutes())}`)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!body.trim()) {
      toast('メッセージ本文を入力してください', 'error')
      return
    }
    if (!date || !time) {
      toast('送信日時を指定してください', 'error')
      return
    }
    const anchorAt = new Date(`${date}T${time}:00`)
    if (Number.isNaN(anchorAt.getTime())) {
      toast('送信日時の形式が不正です', 'error')
      return
    }
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/recurring-posts/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          body: body.trim(),
          bot_display_name: displayName.trim() || null,
          bot_icon: iconUrl ? null : emoji.trim() || null,
          bot_icon_url: iconUrl,
          frequency,
          anchor_at: anchorAt.toISOString(),
        }),
      })
      toast('定期投稿を更新しました')
      await onSaved()
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,24,33,0.45)] p-6" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-[480px] flex-col overflow-hidden rounded-[14px] bg-surface shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-[22px] pb-1 pt-4.5">
          <h2 className="flex-1 text-[15.5px] font-bold text-ink">定期投稿を編集</h2>
          <button type="button" onClick={onClose} className="text-ink-subtle hover:text-ink-muted">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pb-1 pt-4.5">
          <RecurringPostFormFields
            displayName={displayName}
            onDisplayNameChange={setDisplayName}
            emoji={emoji}
            onEmojiChange={setEmoji}
            iconUrl={iconUrl}
            onIconUrlChange={setIconUrl}
            body={body}
            onBodyChange={setBody}
            frequency={frequency}
            onFrequencyChange={setFrequency}
            date={date}
            onDateChange={setDate}
            time={time}
            onTimeChange={setTime}
          />
        </div>
        <div className="px-[22px] pb-5 pt-4">
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink-muted">キャンセル</button>
            <button type="button" disabled={saving} onClick={save} className="flex-1 rounded-lg bg-accent-600 px-3 py-2 text-[13px] font-bold text-white disabled:opacity-40">更新する</button>
          </div>
        </div>
      </div>
    </div>
  )
}

const TRIGGER_TYPE_LABEL: Record<TriggerRule['trigger_type'], string> = { keyword: 'キーワード', emoji: '絵文字' }

// 自動応答トリガーの入力欄（新規作成パネル・編集モーダルの両方から使う共通の見た目）
function TriggerRuleFormFields({
  triggerType, onTriggerTypeChange,
  triggerValue, onTriggerValueChange,
  actionBody, onActionBodyChange,
  displayName, onDisplayNameChange,
  emoji, onEmojiChange,
  iconUrl, onIconUrlChange,
}: {
  triggerType: 'keyword' | 'emoji'
  onTriggerTypeChange: (v: 'keyword' | 'emoji') => void
  triggerValue: string
  onTriggerValueChange: (v: string) => void
  actionBody: string
  onActionBodyChange: (v: string) => void
  displayName: string
  onDisplayNameChange: (v: string) => void
  emoji: string
  onEmojiChange: (v: string) => void
  iconUrl: string | null
  onIconUrlChange: (v: string | null) => void
}) {
  return (
    <>
      <div className="mb-3.5 flex gap-3">
        <div className="flex-1">
          <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">トリガーの種類</label>
          <select
            value={triggerType}
            onChange={(e) => onTriggerTypeChange(e.target.value as typeof triggerType)}
            className="w-full rounded-lg border border-line-strong px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
          >
            <option value="keyword">キーワード</option>
            <option value="emoji">絵文字</option>
          </select>
        </div>
        <div className="flex-1">
          <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">トリガーの値</label>
          <input
            value={triggerValue}
            onChange={(e) => onTriggerValueChange(e.target.value)}
            placeholder={triggerType === 'keyword' ? '例: サポート' : '例: 🚨'}
            maxLength={100}
            className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
          />
        </div>
      </div>

      <div className="mb-3.5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">実行する処理</label>
        <select disabled className="w-full rounded-lg border border-line-strong bg-surface-muted px-2.5 py-2 text-[13px] text-ink-subtle opacity-70">
          <option>メッセージを投稿する</option>
        </select>
        <div className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">
          現時点で選べる処理はメッセージの投稿のみです（本文にURLを含めることもできます）。
        </div>
      </div>

      <div className="mb-3.5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">投稿する本文</label>
        <textarea
          value={actionBody}
          onChange={(e) => onActionBodyChange(e.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="トリガーに一致したときに投稿する内容を入力"
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] leading-relaxed text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>

      <div className="mb-3.5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">送り主の表示名</label>
        <input
          value={displayName}
          onChange={(e) => onDisplayNameChange(e.target.value)}
          placeholder="例: ヘルプ案内Bot"
          maxLength={100}
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>

      <IconInput emoji={emoji} onEmojiChange={onEmojiChange} iconUrl={iconUrl} onIconUrlChange={onIconUrlChange} />

      <div className="mb-3.5 text-[11px] leading-relaxed text-ink-subtle">
        人間の発言のみが判定対象で、BOT自身の投稿が別のトリガーを呼び出すことはありません。チャンネル本体の投稿のみが対象です（スレッド内の発言は対象外）。
      </div>
    </>
  )
}

// 自動応答トリガータブ（A-63〜A-66、F-38）。定期投稿タブと同じ考え方で、新規作成は常時表示のパネル、
// 編集は一覧の「編集」から開くモーダルと画面を分けている（ユーザー指摘を受けて改善）
function TriggerRulesTab({ channelId }: { channelId: string }) {
  const toast = useToast()
  const confirm = useConfirm()
  const { items, mutate } = useTriggerRules(channelId)
  const [editingItem, setEditingItem] = useState<TriggerRule | null>(null)
  const [triggerType, setTriggerType] = useState<'keyword' | 'emoji'>('keyword')
  const [triggerValue, setTriggerValue] = useState('')
  const [actionBody, setActionBody] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [emoji, setEmoji] = useState('⚡')
  const [iconUrl, setIconUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const resetForm = () => {
    setTriggerType('keyword')
    setTriggerValue('')
    setActionBody('')
    setDisplayName('')
    setEmoji('⚡')
    setIconUrl(null)
  }

  useEffect(() => {
    resetForm()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId])

  const submit = async () => {
    if (!triggerValue.trim()) {
      toast('トリガーの値を入力してください', 'error')
      return
    }
    if (!actionBody.trim()) {
      toast('投稿する本文を入力してください', 'error')
      return
    }
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/trigger-rules`, {
        method: 'POST',
        body: JSON.stringify({
          trigger_type: triggerType,
          trigger_value: triggerValue.trim(),
          action_body: actionBody.trim(),
          bot_display_name: displayName.trim() || null,
          bot_icon: iconUrl ? null : emoji.trim() || null,
          bot_icon_url: iconUrl,
        }),
      })
      toast('トリガーを追加しました')
      await mutate()
      resetForm()
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (item: TriggerRule) => {
    try {
      await apiFetch(`/api/channels/${channelId}/trigger-rules/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !item.is_active }),
      })
      await mutate()
    } catch (e) {
      toast(e instanceof Error ? e.message : '変更に失敗しました', 'error')
    }
  }

  const remove = async (item: TriggerRule) => {
    const ok = await confirm({
      title: 'トリガーを削除',
      message: `「${item.bot_display_name}」のトリガーを削除しますか？ 既に投稿済みの発言は残ります。`,
      confirmLabel: '削除する',
      danger: true,
    })
    if (!ok) return
    try {
      await apiFetch(`/api/channels/${channelId}/trigger-rules/${item.id}`, { method: 'DELETE' })
      await mutate()
      if (editingItem?.id === item.id) setEditingItem(null)
      toast('トリガーを削除しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '削除に失敗しました', 'error')
    }
  }

  return (
    <div className="max-w-[700px]">
      <p className="mb-5 text-[12.5px] leading-relaxed text-ink-muted">
        特定のキーワードまたは絵文字を含む発言があったとき、自動でメッセージを投稿します（F-38）。チャンネルAIとは別物で、単純な一致判定のみで動作します。
      </p>

      <ul className="mb-6 space-y-2.5">
        {items.length === 0 && <p className="text-[12px] text-ink-subtle">トリガーはまだありません。</p>}
        {items.map((item) => (
          <li key={item.id} className="rounded-[10px] border border-line px-3.5 py-3">
            <div className="flex items-center gap-2">
              <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10.5px] font-bold text-ink-muted">
                {TRIGGER_TYPE_LABEL[item.trigger_type]}
              </span>
              <span className="text-[13px] font-bold text-ink">「{item.trigger_value}」</span>
              <span className="ml-auto text-[11.5px] text-ink-subtle">→ メッセージを投稿</span>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-subtle">
              送り主:
              {item.bot_icon_url ? (
                <img src={item.bot_icon_url} alt="" className="h-4 w-4 rounded-[5px] object-cover" />
              ) : (
                <span className="text-[12px]">{item.bot_icon || '⚡'}</span>
              )}
              {item.bot_display_name}
            </div>
            <div className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink">{item.action_body}</div>
            <div className="mt-2.5 flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => toggleActive(item)}
                className={`relative h-[18px] w-[32px] flex-none rounded-full transition-colors ${
                  item.is_active ? 'bg-accent-600' : 'bg-line-strong'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-[14px] w-[14px] rounded-full bg-white shadow transition-all ${
                    item.is_active ? 'left-[16px]' : 'left-0.5'
                  }`}
                />
              </button>
              <span className="text-[11.5px] text-ink-subtle">{item.is_active ? '有効' : '一時停止中'}</span>
              <div className="ml-auto flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setEditingItem(item)}
                  className="rounded-md border border-line-strong px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700"
                >
                  編集
                </button>
                <button
                  type="button"
                  onClick={() => remove(item)}
                  className="rounded-md border border-line-strong px-2.5 py-1 text-[11.5px] font-semibold text-danger-text hover:border-danger-border hover:bg-danger-bg"
                >
                  削除
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <div className="rounded-[10px] border border-dashed border-line-strong bg-surface-subtle px-4 py-4">
        <div className="mb-3.5 text-[12.5px] font-bold text-ink">＋ 新しいトリガーを追加</div>

        <TriggerRuleFormFields
          triggerType={triggerType}
          onTriggerTypeChange={setTriggerType}
          triggerValue={triggerValue}
          onTriggerValueChange={setTriggerValue}
          actionBody={actionBody}
          onActionBodyChange={setActionBody}
          displayName={displayName}
          onDisplayNameChange={setDisplayName}
          emoji={emoji}
          onEmojiChange={setEmoji}
          iconUrl={iconUrl}
          onIconUrlChange={setIconUrl}
        />

        <div className="flex gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={submit}
            className="rounded-lg bg-accent-600 px-4 py-2 text-[13px] font-bold text-white disabled:opacity-40"
          >
            ＋ トリガーを追加
          </button>
        </div>
      </div>

      {editingItem && (
        <TriggerRuleEditModal
          key={editingItem.id}
          item={editingItem}
          channelId={channelId}
          onClose={() => setEditingItem(null)}
          onSaved={mutate}
        />
      )}
    </div>
  )
}

// 自動応答トリガーの編集モーダル（一覧の「編集」から開く）
function TriggerRuleEditModal({
  item, channelId, onClose, onSaved,
}: {
  item: TriggerRule
  channelId: string
  onClose: () => void
  onSaved: () => Promise<unknown>
}) {
  const toast = useToast()
  const [triggerType, setTriggerType] = useState(item.trigger_type)
  const [triggerValue, setTriggerValue] = useState(item.trigger_value)
  const [actionBody, setActionBody] = useState(item.action_body)
  const [displayName, setDisplayName] = useState(item.bot_display_name)
  const [emoji, setEmoji] = useState(item.bot_icon ?? '⚡')
  const [iconUrl, setIconUrl] = useState<string | null>(item.bot_icon_url)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!triggerValue.trim()) {
      toast('トリガーの値を入力してください', 'error')
      return
    }
    if (!actionBody.trim()) {
      toast('投稿する本文を入力してください', 'error')
      return
    }
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/trigger-rules/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          trigger_type: triggerType,
          trigger_value: triggerValue.trim(),
          action_body: actionBody.trim(),
          bot_display_name: displayName.trim() || null,
          bot_icon: iconUrl ? null : emoji.trim() || null,
          bot_icon_url: iconUrl,
        }),
      })
      toast('トリガーを更新しました')
      await onSaved()
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,24,33,0.45)] p-6" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-[480px] flex-col overflow-hidden rounded-[14px] bg-surface shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-[22px] pb-1 pt-4.5">
          <h2 className="flex-1 text-[15.5px] font-bold text-ink">トリガーを編集</h2>
          <button type="button" onClick={onClose} className="text-ink-subtle hover:text-ink-muted">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pb-1 pt-4.5">
          <TriggerRuleFormFields
            triggerType={triggerType}
            onTriggerTypeChange={setTriggerType}
            triggerValue={triggerValue}
            onTriggerValueChange={setTriggerValue}
            actionBody={actionBody}
            onActionBodyChange={setActionBody}
            displayName={displayName}
            onDisplayNameChange={setDisplayName}
            emoji={emoji}
            onEmojiChange={setEmoji}
            iconUrl={iconUrl}
            onIconUrlChange={setIconUrl}
          />
        </div>
        <div className="px-[22px] pb-5 pt-4">
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink-muted">キャンセル</button>
            <button type="button" disabled={saving} onClick={save} className="flex-1 rounded-lg bg-accent-600 px-3 py-2 text-[13px] font-bold text-white disabled:opacity-40">更新する</button>
          </div>
        </div>
      </div>
    </div>
  )
}
