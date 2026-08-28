import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useChannel } from '../hooks/useChannels'
import { useChannelMembers } from '../hooks/useChannelMembers'
import { useAiSettings } from '../hooks/useAiSettings'
import { useMe } from '../hooks/useMe'
import { apiFetch, ApiError, uploadIcon } from '../lib/api'
import { avatarColorFor } from '../lib/avatarColor'
import { useToast } from '../components/Toast'
import { useConfirm } from '../components/ui/ConfirmDialog'
import type { AiSettings } from '../types'

const ICON_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_ICON_BYTES = 5 * 1024 * 1024

// S-06 チャンネル設定。このスライスは4タブ（チャンネル管理者・基本設定・キャラクタ・振る舞い定義）を
// 実装。「参照ドキュメント範囲」「スキル」「反応モード」「自動対応範囲」および「定期投稿」
// 「自動応答トリガー」タブはドキュメントQ&A・スケジューラ・自動対応分類が未実装のため対象外
// （CLAUDE.md 実装状況節）。タブ切替はLayout.tsxと共有する?tab=クエリパラメータで行う。
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
      </div>
    </div>
  )
}

function AdminTab({ channelId }: { channelId: string }) {
  const toast = useToast()
  const confirm = useConfirm()
  const { channel, mutate: mutateChannel } = useChannel(channelId)
  const { members, mutate: mutateMembers } = useChannelMembers(channelId)

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
