import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useChannel, useChannels } from '../hooks/useChannels'
import { useChannelMembers } from '../hooks/useChannelMembers'
import { useAiSettings } from '../hooks/useAiSettings'
import { useDocFolders } from '../hooks/useDocFolders'
import { useRecurringPosts } from '../hooks/useRecurringPosts'
import { useTriggerRules } from '../hooks/useTriggerRules'
import { useOverlayClose } from '../hooks/useOverlayClose'
import { useReportDirty } from '../lib/unsavedChanges'
import { GuardedLink } from '../components/GuardedLink'
import MobileBackLink from '../components/MobileBackLink'
import { useMe } from '../hooks/useMe'
import DocPreviewModal, { docPreviewKind } from '../components/DocPreviewModal'
import { apiFetch, ApiError, uploadIcon } from '../lib/api'
import { avatarColorFor } from '../lib/avatarColor'
import { useToast } from '../components/Toast'
import { useConfirm } from '../components/ui/ConfirmDialog'
import Composer, { type MentionCandidate } from '../components/Composer'
import { trimMessageBody } from '../lib/textFormatting'
import type {
  AiSettings, AutoResponseRule, ChannelDetail, DocFolder, DocPermissionConflict, MentionPayload, RecurringPost,
  Skill, TriggerRule,
} from '../types'

const ICON_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_ICON_BYTES = 5 * 1024 * 1024

// S-06 チャンネル設定。9タブ（チャンネル管理者・基本設定・キャラクタ・振る舞い定義・
// 参照ドキュメント範囲・スキルと対応範囲設定・反応モード・定期投稿・自動応答トリガー）を実装。
// 「スキルと対応範囲設定」は旧「スキル」「自動対応範囲」の2タブを2026-09-29に画面上だけ統合したもの。
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
      <div className="flex-none border-b border-line bg-surface px-7 max-md:px-4 py-3.5">
        <GuardedLink to={`/channels/${channelId}`} className="text-xs text-accent-700 hover:underline max-md:hidden">
          ← # {channel?.name ?? ''} に戻る
        </GuardedLink>
        {/* スマホ表示（F-32）では設定項目の一覧（Layout.tsxのサイドバー側の画面）へ戻る */}
        <MobileBackLink to={`/channels/${channelId}/settings`} className="text-xs text-accent-700 hover:underline">
          ← チャンネル設定
        </MobileBackLink>
        <div className="mt-1 text-[15px] font-bold text-ink">チャンネル設定</div>
      </div>

      <div className="flex-1 overflow-y-auto px-7 max-md:px-4 py-5.5">
        {tab === 'general' && channelId && settings && (
          <GeneralTab channelId={channelId} channelName={channel?.name ?? ''} settings={settings} mutate={mutateAi} />
        )}
        {tab === 'character' && channelId && settings && (
          <CharacterTab channelId={channelId} settings={settings} mutate={mutateAi} />
        )}
        {tab === 'prompt' && channelId && settings && (
          <PromptTab channelId={channelId} settings={settings} mutate={mutateAi} />
        )}
        {tab === 'docscope' && channelId && settings && channel && (
          <DocScopeTab channelId={channelId} settings={settings} mutate={mutateAi} isPublic={channel.is_public} isMember={channel.is_member} />
        )}
        {(tab === 'skills' || tab === 'auto') && channelId && settings && (
          <TasksTab channelId={channelId} settings={settings} mutate={mutateAi} />
        )}
        {tab === 'reaction' && channelId && settings && (
          <ReactionTab channelId={channelId} settings={settings} mutate={mutateAi} />
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
  // 未保存の変更ガード（2026-09-11）。propの channel.name/topic は再検証のたびに更新されうる
  // （trimされる等、微妙にlocal stateとズレることもある）ため、保存済みの値を専用のstateで
  // 別管理し、保存成功時に更新する。**useRefではなくuseStateにしている**のは、useRefへの
  // 単純な代入（baselineRef.current = ...）は値を変えるだけで再レンダーを引き起こさず、
  // その後たまたま他の理由（他のstate更新等）で再レンダーが起きるまでuseReportDirty側の
  // 判定が更新されない実バグを実機検証で発見したため（setName(trimmed)等の「保存後に入力欄も
  // 揃える」処理が、末尾空白等が無く値が変わらない場合はReactの同値bailoutで再レンダー自体を
  // 起こさず、保存直後もダイアログが出続ける不具合として顕在化した）。setBaselineは常に新しい
  // オブジェクトを渡すため、値の変化に関わらず確実に再レンダーが起き、その場でdirty判定が
  // 正しく更新される。
  const [baseline, setBaseline] = useState({ name: channel.name, topic: channel.topic ?? '' })
  useReportDirty(name !== baseline.name || topic !== baseline.topic)

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      toast('チャンネル名を入力してください', 'error')
      return
    }
    setSaving(true)
    try {
      const trimmedTopic = topic.trim()
      await apiFetch(`/api/channels/${channelId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: trimmed, topic: trimmedTopic }),
      })
      // 入力欄も保存した値（trim後）に揃える
      setName(trimmed)
      setTopic(trimmedTopic)
      setBaseline({ name: trimmed, topic: trimmedTopic })
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
          maxLength={80}
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>

      <div className="mb-3">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">説明（任意）</label>
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="このチャンネルの目的を入力"
          maxLength={500}
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

// 基本設定タブ（A-24、F-08）。reaction_modeは反応モードタブ（ReactionTab）が担当するため、
// ここでは現在値をそのまま一緒に送るだけで変更しない（A-27参照ドキュメント範囲と同じ考え方）。
// AIモデル選択（2026-09-17、ユーザーからの明示的な要望）もこのタブに同居させる
// （「有効/無効」と同じ「AIの動作そのものに関する基本的な設定」という位置づけ）
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
        body: JSON.stringify({
          is_ai_enabled: !settings.is_ai_enabled,
          reaction_mode: settings.reaction_mode,
          ai_model: settings.ai_model,
        }),
      })
      await mutate()
      toast(settings.is_ai_enabled ? 'AIを無効にしました' : 'AIを有効にしました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '変更に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  const changeModel = async (value: string) => {
    if (value === settings.ai_model || saving) return
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/ai-settings/general`, {
        method: 'PUT',
        body: JSON.stringify({
          is_ai_enabled: settings.is_ai_enabled,
          reaction_mode: settings.reaction_mode,
          ai_model: value,
        }),
      })
      await mutate()
      toast('AIモデルを更新しました')
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

      <div className="mt-5 rounded-[10px] border border-line bg-surface-subtle px-3.5 py-3">
        <label className="field-label mb-1.5 block text-[13px] font-bold text-ink">AIモデル</label>
        <select
          value={settings.ai_model}
          onChange={(e) => changeModel(e.target.value)}
          disabled={saving}
          className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-ink"
        >
          {settings.available_models.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <div className="mt-1.5 text-[11.5px] text-ink-subtle">
          応答生成に使うOpenAIのモデルをチャンネルごとに指定します。モデルによって応答速度・品質・コストが異なります（各選択肢の括弧内を参照）。
        </div>
      </div>
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
  const [name, setName] = useState(settings.persona_name ?? 'Kogack AI')
  const [tone, setTone] = useState(settings.persona_tone ?? '')
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 未保存の変更ガード（2026-09-11）。アイコンの新規選択（file !== null、まだアップロード
  // していない）も未保存の変更として扱う。useRefではなくuseStateにしている理由は
  // ChannelInfoForm.baselineのコメントを参照（保存成功時の再レンダーを確実にするため）
  const [baseline, setBaseline] = useState({ name: settings.persona_name ?? 'Kogack AI', tone: settings.persona_tone ?? '' })
  useReportDirty(name !== baseline.name || tone !== baseline.tone || file !== null)

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
      const trimmedTone = tone.trim()
      await apiFetch(`/api/channels/${channelId}/ai-settings/character`, {
        method: 'PUT',
        body: JSON.stringify({
          persona_name: trimmed,
          persona_icon_url: iconUrl,
          persona_tone: trimmedTone || null,
        }),
      })
      // ChannelInfoForm.saveと同じ理由で、入力欄も保存した値（trim後）に揃える
      setName(trimmed)
      setTone(trimmedTone)
      setBaseline({ name: trimmed, tone: trimmedTone })
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
          maxLength={50}
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

// 振る舞い定義タブ（A-26、F-09）。上書き保存のみで過去バージョンは持たない。変更者・日時は
// 監査ログ（T-16、A-44、S-08管理コンソール「監査ログ」タブ）に記録される（2026-09-01実装済み）。
// ヒント文言はこの記録先を画面モックアップどおり明記する（バックエンドは既に記録しているのに、
// このタブのヒントだけ「未実装」時点のまま更新されておらず、chadmin本人が記録の存在を知る
// 手段が画面上に無かった不具合。ユーザーからの指摘で発覚し修正した）
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
  // 未保存の変更ガード（2026-09-11）。useRefではなくuseStateにしている理由は
  // ChannelInfoForm.baselineのコメントを参照
  const [baseline, setBaseline] = useState(settings.behavior_prompt ?? '')
  useReportDirty(prompt !== baseline)

  const save = async () => {
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/ai-settings/prompt`, {
        method: 'PUT',
        body: JSON.stringify({ behavior_prompt: prompt }),
      })
      setBaseline(prompt)
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
        placeholder="例: あなたは総務部の問い合わせ窓口です。社内規程に基づいて答え、規程に書かれていないことは推測せず総務部への確認を案内してください。"
        className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] leading-relaxed text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
      />
      <div className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">
        編集のたびに上書き保存されます。変更者・日時は監査ログ（S-08管理コンソール）に記録されます（過去バージョンの一覧・差分表示は対象外）。
      </div>
      <BehaviorPromptExamples prompt={prompt} onToggle={(text) => setPrompt((cur) => toggleExample(cur, text))} />
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

// 振る舞い定義の書き方の例（ユーザー要望、2026-10-01）。名前・口調は「キャラクタ」タブ、任せる業務・
// 断る依頼は「スキルと対応範囲設定」タブが担当するため、例はそれ以外（役割・答え方・してはいけないこと）に絞る。
// ボタンはトグル式: 例文が入力欄に含まれていなければ既存の記述を消さないよう末尾に追記し、含まれていれば
// その例文（と区切りの空行）だけを取り除く（ユーザー要望、2回押したら2個分入るのではなく消えてほしい）。
// 追加後に例文を書き換えた場合は一致しなくなるため、再び「追加」扱いになる
const BEHAVIOR_PROMPT_EXAMPLES: { title: string; text: string }[] = [
  {
    title: '社内の問い合わせ窓口',
    text: `あなたは総務部の問い合わせ窓口です。社員からの備品・各種申請・社内規程に関する質問に答えます。
・参照ドキュメント（社内規程）に書かれている内容を根拠に答え、該当する規程の名前を添えてください。
・規程に書かれていないことは推測で答えず、「総務部（内線123）にご確認ください」と案内してください。
・給与や人事評価など個人に関わる相談には答えず、担当者への直接の相談を勧めてください。`,
  },
  {
    title: '開発チームのサポート',
    text: `あなたは開発チームのサポート役です。メンバーからの技術的な質問やコードレビューの相談に答えます。
・回答は結論を先に書き、必要に応じてコード例を添えてください。
・社内のコーディング規約に関わる質問は、参照ドキュメントの規約を優先してください。
・本番環境の操作手順は答えず、チームリーダーへの確認を案内してください。`,
  },
  {
    title: '雑談・アイデア出し',
    text: `あなたはチームの雑談とアイデア出しの相手です。
・堅苦しくならないよう、短めの返答を心がけてください。
・アイデアを求められたら、方向性の違う案を3つほど挙げてください。
・業務上の正式な判断が必要な話題になったら、担当者に確認するよう一言添えてください。`,
  },
]

function toggleExample(cur: string, text: string): string {
  const i = cur.indexOf(text)
  if (i < 0) return (cur.trim() ? `${cur.replace(/\s+$/, '')}\n\n${text}` : text).slice(0, 8000)
  const before = cur.slice(0, i).replace(/\s+$/, '')
  const after = cur.slice(i + text.length).replace(/^\s+/, '')
  return before && after ? `${before}\n\n${after}` : before || after
}

function BehaviorPromptExamples({ prompt, onToggle }: { prompt: string; onToggle: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-3 rounded-lg border border-line bg-surface-subtle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12.5px] font-bold text-ink-muted hover:text-accent-700"
      >
        <span className="text-[10px]">{open ? '▼' : '▶'}</span>
        書き方の例を見る
      </button>
      {open && (
        <div className="border-t border-line px-3 pb-3 pt-2">
          <p className="mb-2 text-[11.5px] leading-relaxed text-ink-subtle">
            「AIの役割」「答え方」「してはいけないこと」を箇条書きで書くと伝わりやすくなります。名前・口調は「キャラクタ」タブ、AIに任せる業務や断る依頼は「スキルと対応範囲設定」タブで設定します。
          </p>
          {BEHAVIOR_PROMPT_EXAMPLES.map((ex) => {
            const added = prompt.includes(ex.text)
            return (
              <div key={ex.title} className="mt-2.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[12px] font-bold text-ink">{ex.title}</span>
                  <button
                    type="button"
                    onClick={() => onToggle(ex.text)}
                    className={
                      added
                        ? 'rounded-md border border-accent-600 bg-accent-50 px-2 py-0.5 text-[11px] font-semibold text-accent-700 hover:bg-white'
                        : 'rounded-md border border-line-strong bg-white px-2 py-0.5 text-[11px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700'
                    }
                  >
                    {added ? '入力欄から取り除く' : '入力欄に追加'}
                  </button>
                </div>
                <pre className="whitespace-pre-wrap rounded-md border border-line bg-white px-2.5 py-2 font-sans text-[12px] leading-relaxed text-ink-muted">
                  {ex.text}
                </pre>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// 画面モックアップのカード型ラジオ（タイトル＋説明文＋選択時に塗りつぶされるドット）。
// DocScopeTab（参照範囲外の質問への対応）・ReactionTab（反応モード）で共有する。選択時の即保存/
// バッチ保存の違いはonClick側の実装に委ねる（このコンポーネント自体は見た目のみ）
function RadioCard({
  title,
  sub,
  selected,
  onClick,
  disabled,
}: {
  title: string
  sub: string
  selected: boolean
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-start gap-3 rounded-[10px] border px-3.5 py-3 text-left transition-colors disabled:opacity-60 ${
        selected ? 'border-accent-600 bg-accent-50' : 'border-line bg-surface-subtle hover:border-line-strong'
      }`}
    >
      <span
        className={`relative mt-0.5 h-[17px] w-[17px] flex-none rounded-full border-2 ${
          selected ? 'border-accent-600' : 'border-line-strong'
        }`}
      >
        {selected && (
          <span className="absolute left-1/2 top-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-600" />
        )}
      </span>
      <span>
        <div className="text-[13.5px] font-bold text-ink">{title}</div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-ink-subtle">{sub}</div>
      </span>
    </button>
  )
}

// A-27: 参照ドキュメント範囲タブ（F-11・F-22）。候補（doc_folders）はS-08管理コンソールの
// 「ドキュメント参照範囲」タブで管理者が登録し、ここではチャンネルごとに使用する候補を選ぶ
// （T-10 channel_doc_foldersの洗い替え）。実際のDrive同期・索引・AI検索（search_documentsツール）
// は次のスライスで実装するため、この設定はまだAI応答には反映されない（CLAUDE.md実装状況節）
function DocScopeTab({
  channelId,
  settings,
  mutate,
  isPublic,
  isMember,
}: {
  channelId: string
  settings: AiSettings
  mutate: () => Promise<AiSettings | undefined>
  isPublic: boolean
  isMember: boolean
}) {
  // 「選択済みファイルを含むフォルダは初期状態から展開しておく」という初期化ロジックが`folders`
  // （useDocFolders、settingsとは別のフック）に依存するため、folders未ロードのままだと
  // expandedFoldersのuseState初期値が「空」のまま固定されてしまう不具合を実機検証で発見した
  // （GlobalLimitForm等と同じ「非同期データが揃ってから条件付きレンダーし、propsからuseStateの
  // 初期値を直接設定する」パターンで解消する）。
  const { folders, isLoading } = useDocFolders()
  if (isLoading) return <p className="text-[12.5px] text-ink-subtle">読み込み中...</p>
  return (
    <DocScopeTabBody
      channelId={channelId} settings={settings} mutate={mutate} isPublic={isPublic} isMember={isMember} folders={folders}
    />
  )
}

function DocScopeTabBody({
  channelId,
  settings,
  mutate,
  isPublic,
  isMember,
  folders,
}: {
  channelId: string
  settings: AiSettings
  mutate: () => Promise<AiSettings | undefined>
  isPublic: boolean
  isMember: boolean
  folders: DocFolder[]
}) {
  const toast = useToast()
  const confirm = useConfirm()
  const { me } = useMe()
  // 文書のプレビュー（2026-10-01、ユーザーからの要望）。全員に公開している文書か、自分が閲覧者に
  // 入っている限定公開の文書だけ開ける（サーバー側のpreview_doc_for_scopeでも同じ条件で判定する）
  const [previewTarget, setPreviewTarget] = useState<DocFolder | null>(null)
  const canPreview = (f: DocFolder) =>
    !f.is_restricted || me?.role === 'admin' || (me ? f.viewer_user_ids.includes(me.id) : false)
  // 自分が閲覧者に入っていない限定公開の文書は選べない（2026-10-01、ユーザーからの指摘）。選べてしまうと
  // 保存時に「自分を強制退出させますか？」→「最後のチャンネル管理者は退出させられません」と回りくどく
  // 断られていた。チャンネルに参加していないシステム管理者は退出の対象にならないため選べる
  const isSelfBlocked = (f: DocFolder) =>
    f.is_restricted && isMember && !(me ? f.viewer_user_ids.includes(me.id) : false)
  const [selected, setSelected] = useState(() => new Set(settings.folder_ids))
  const [policy, setPolicy] = useState(settings.out_of_scope_policy)
  const [saving, setSaving] = useState(false)
  // 未保存の変更ガード（2026-09-11）。selectedはSetのため、並び順に依存しないソート済み配列で
  // 比較する。保存成功時（force=trueの経路も含む）にbaselineを更新する。useRefではなく
  // useStateにしている理由はChannelInfoForm.baselineのコメントを参照
  const [baseline, setBaseline] = useState({ selected: [...settings.folder_ids].sort(), policy: settings.out_of_scope_policy })
  const isDirty =
    policy !== baseline.policy || JSON.stringify([...selected].sort()) !== JSON.stringify(baseline.selected)
  useReportDirty(isDirty)
  // フォルダ名クリックで中身を展開/折りたたみする（ユーザーからの明示的な要望「フォルダ名をクリックすると
  // その中のファイルが表示されて、一つずつチェックボックスで選択できるみたいな感じ」）。既に選択済みの
  // ファイルを含むフォルダは初期状態から展開しておく（保存済みの選択が畳まれて見えなくなるのを防ぐ）
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    const withSelectedChildren = new Set<string>()
    for (const f of settings.folder_ids) {
      const child = folders.find((x) => x.id === f)
      if (child?.parent_folder_id) withSelectedChildren.add(child.parent_folder_id)
    }
    return withSelectedChildren
  })
  const toggleExpand = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggle = (f: DocFolder) => {
    // 閲覧権限モデル（Slice 2b、2026-09-09、(4)）: 公開チャンネルは限定公開フォルダを
    // 一切選べない（保存時にサーバー側でも拒否されるが、選べてしまうこと自体が誤解を招くため
    // フロント側でも選択自体をブロックする）
    if (isPublic && f.is_restricted) {
      toast('公開チャンネルには限定公開のフォルダを含められません', 'error')
      return
    }
    if (isSelfBlocked(f) && !selected.has(f.id)) {
      toast('あなたに閲覧権限がないため選べません', 'error')
      return
    }
    // フォルダ（parent_folder_id無しのitem_type='folder'）のチェックボックスは、その配下の
    // 全ファイルとも連動させる（ユーザーからの明示的な要望「フォルダにチェックを入れたら
    // 自動的にそのフォルダの中にあるファイルすべてにチェックが入るようにしてほしい」、
    // 2026-09-11）。**単なる見た目の便宜ではなく機能上も必要**: 索引化（doc_chunks）は
    // 個々のファイル自身に対して行われ、フォルダ自身のindex_status は常に'not_applicable'の
    // ままindex_status='ready'になることが無いため（doc_search.search・channel_has_indexed_documents
    // 参照）、フォルダのidだけをchannel_doc_foldersに入れても実際には何も検索対象に含まれない。
    // 中のファイルを個別にチェックして初めてAI検索が機能する仕様のため、この連動が無いと
    // 「フォルダにチェックを入れたのに何も参照されない」という分かりにくい状態になっていた。
    const children = f.parent_folder_id === null && f.item_type === 'folder'
      ? folders.filter((c) => c.parent_folder_id === f.id)
      : []
    const willCheck = !selected.has(f.id)
    setSelected((prev) => {
      const next = new Set(prev)
      if (willCheck) next.add(f.id)
      else next.delete(f.id)
      for (const c of children) {
        // 公開チャンネルで限定公開の子ファイルは連動対象から除外する（disabled表示のチェック
        // ボックスを裏側から勝手にONにしてしまわないよう、上のガードと同じ条件で守る）
        if (isPublic && c.is_restricted) continue
        if (willCheck && isSelfBlocked(c)) continue
        if (willCheck) next.add(c.id)
        else next.delete(c.id)
      }
      return next
    })
    // フォルダをチェックした際、連動して子ファイルにもチェックが入ったことがその場で見えるよう、
    // まだ畳まれていれば展開する（未チェック化の際は畳んだままにする、チェックを外しただけで
    // 表示状態まで変えると挙動が読みにくくなるため）
    if (willCheck && children.length > 0) {
      setExpandedFolders((prev) => new Set(prev).add(f.id))
    }
  }

  const save = async (force = false) => {
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/ai-settings/doc-scope`, {
        method: 'PUT',
        body: JSON.stringify({ folder_ids: Array.from(selected), out_of_scope_policy: policy, force }),
      })
      setBaseline({ selected: [...selected].sort(), policy })
      await mutate()
      toast('参照ドキュメント範囲を保存しました')
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.detailObj) {
        const detail = e.detailObj as DocPermissionConflict
        const names = detail.affected
          .flatMap((a) => a.members.map((m) => `${a.folder_name}: ${m.name}`))
          .join('、')
        const ok = await confirm({
          title: '閲覧権限のない参加者がいます',
          message: `次の参加者は追加しようとしている文書の閲覧権限がありません: ${names}。「はい」を押すと、これらの参加者をこのチャンネルから強制的に退出させたうえで参照範囲に追加します。よろしいですか？`,
          confirmLabel: 'はい（強制退出させて保存）',
          danger: true,
        })
        if (ok) {
          setSaving(false)
          await save(true)
          return
        }
      } else {
        toast(e instanceof Error ? e.message : '保存に失敗しました', 'error')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-[560px]">
      <p className="mb-5 text-[12.5px] leading-relaxed text-ink-muted">
        チャンネルAIが回答の根拠として参照する社内ドキュメントを選びます（F-11・F-22）。候補は管理コンソールの「ドキュメント参照範囲」タブでシステム管理者が登録します。「プレビュー」で中身を確認できます。限定公開の文書は、自分が閲覧者に入っているものだけプレビュー・選択できます（「閲覧権限なし」の文書が必要な場合は、システム管理者に閲覧者への追加を依頼してください）。
      </p>

      <div className="mb-5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">参照するフォルダ・ファイル</label>
        {folders.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-line-strong px-3.5 py-3 text-[12px] text-ink-subtle">
            登録済みの候補がありません。管理コンソールの「ドキュメント参照範囲」タブから登録してください。
          </p>
        ) : (
          <div className="overflow-hidden rounded-[10px] border border-line">
            {/* トップレベル項目（Driveフォルダ・アップロードした単独ファイルの両方、parent_folder_id無し）の
                直下に、そのフォルダに登録済みのファイルを並べた1本のフラットな行リストにする（画面モックアップ
                の.doc-tree/.doc-row/.doc-row.childと同じ構造）。子行は字下げ＋背景色を変え、
                「このファイルがどのフォルダの中にあるか」を一目で分かるようにする。境界線はネストではなく
                flatRows全体に対して最後の行だけborder-b-0にする（ネストしたlast-childでは
                フォルダブロックの区切りごとに線が抜けてしまうため）。フォルダ名クリックで子ファイルを
                展開/折りたたみする（ユーザーからの明示的な要望）。チェックボックスは選択専用、
                フォルダ名部分（▶/▼ボタン）は展開専用と役割を分けている */}
            {(() => {
              type Row = { folder: DocFolder; isChild: boolean; childCount: number }
              const flatRows: Row[] = []
              folders
                .filter((f) => f.parent_folder_id === null)
                .forEach((f) => {
                  const children = f.item_type === 'folder' ? folders.filter((c) => c.parent_folder_id === f.id) : []
                  flatRows.push({ folder: f, isChild: false, childCount: children.length })
                  if (expandedFolders.has(f.id)) {
                    children.forEach((c) => flatRows.push({ folder: c, isChild: true, childCount: 0 }))
                  }
                })
              return flatRows.map(({ folder: f, isChild, childCount }, idx) => {
                const selfBlocked = !isPublic && isSelfBlocked(f) && !selected.has(f.id)
                const disabled = (isPublic && f.is_restricted) || selfBlocked
                const isLast = idx === flatRows.length - 1
                const expanded = !isChild && expandedFolders.has(f.id)
                return (
                  <div
                    key={f.id}
                    className={`flex items-center gap-2 text-ink ${isLast ? '' : 'border-b border-line'} ${
                      isChild
                        ? 'bg-surface-subtle py-2 pl-[38px] pr-3.5 text-[12.5px]'
                        : 'bg-surface px-3.5 py-2.5 text-[13px]'
                    } ${disabled ? 'opacity-40' : ''}`}
                    title={
                      selfBlocked
                        ? me?.role === 'admin'
                          ? '閲覧者に入っていないため選べません。管理コンソールで自分を閲覧者に追加してください'
                          : 'あなたに閲覧権限がないため選べません。必要な場合は、システム管理者にあなたを閲覧者へ追加するよう依頼してください'
                        : disabled
                          ? `公開チャンネルには限定公開の${isChild ? 'ファイル' : 'フォルダ'}を含められません`
                          : undefined
                    }
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(f.id)}
                      onChange={() => toggle(f)}
                      disabled={disabled}
                      className="h-3.5 w-3.5 flex-none accent-accent-600"
                    />
                    {!isChild && childCount > 0 ? (
                      <button
                        type="button"
                        onClick={() => toggleExpand(f.id)}
                        className="flex min-w-0 flex-1 items-center gap-2 bg-transparent text-left"
                      >
                        <span className="flex-none text-[10px] text-ink-subtle">{expanded ? '▼' : '▶'}</span>
                        <span className="flex-none text-sm">📁</span>
                        <span className="truncate">{f.drive_folder_name}</span>
                        <span className="flex-none text-[11px] text-ink-subtle">（{childCount}件登録済み）</span>
                      </button>
                    ) : (
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="flex-none text-sm">
                          {isChild ? '📄' : f.item_type === 'folder' ? '📁' : f.source === 'upload' ? '📎' : '📄'}
                        </span>
                        <span className="truncate">{f.drive_folder_name}</span>
                      </span>
                    )}
                    {/* プレビューできない・選べない理由が分かるよう、自分が閲覧者に入っていない限定公開の
                        文書には形式に関係なく「閲覧権限なし」を出す */}
                    {f.is_restricted && !canPreview(f) ? (
                      <span
                        className="flex-none text-[11px] text-ink-subtle"
                        title="この文書の閲覧者に入っていないため、中身の表示・参照範囲への追加はできません"
                      >
                        閲覧権限なし
                      </span>
                    ) : isSelfBlocked(f) ? (
                      // システム管理者は中身を確認できるが、閲覧者に入っていない参加者として退出の対象になるため選べない
                      <span
                        className="flex-none text-[11px] text-ink-subtle"
                        title="閲覧者に入っていないため、参照範囲には追加できません。管理コンソールで自分を閲覧者に追加してください"
                      >
                        閲覧者に未登録
                      </span>
                    ) : null}
                    {f.item_type === 'file' && f.source === 'upload' && docPreviewKind(f.drive_folder_name) !== null &&
                      canPreview(f) && (
                        <button
                          type="button"
                          onClick={() => setPreviewTarget(f)}
                          className="flex-none bg-transparent text-[11.5px] text-accent-700 hover:underline"
                        >
                          プレビュー
                        </button>
                      )}
                    {f.is_restricted && (
                      <span className="flex-none rounded-full bg-danger-bg px-1.5 py-0.5 text-[10px] font-bold text-danger-text">
                        🔒 限定公開
                      </span>
                    )}
                  </div>
                )
              })
            })()}
          </div>
        )}
        <div className="mt-1.5 text-[11px] leading-relaxed text-ink-subtle">
          フォルダ名（▶）をクリックすると中のファイルが表示されます。フォルダにチェックすると、そのフォルダ全体が参照範囲に含まれます。特定のファイルだけを含めたい場合は、展開した中の個別ファイルだけを選んでください（フォルダ・ファイルの登録は管理コンソールから行います）。
        </div>
      </div>

      <div className="mb-5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">参照範囲外の質問への対応</label>
        <div className="space-y-2.5">
          <RadioCard
            title="厳格に制限"
            sub="登録されたドキュメントや振る舞い定義・スキルの範囲外の質問には対応せず、「担当外のためお答えできません」のようにお断りする。"
            selected={policy === 'strict'}
            onClick={() => setPolicy('strict')}
          />
          <RadioCard
            title="一般回答を許可"
            sub="登録ドキュメントに根拠がない質問でも、AIの一般的な知識を使って回答する。社内ドキュメントを根拠にできる質問については、そちらを優先する。"
            selected={policy === 'general'}
            onClick={() => setPolicy('general')}
          />
        </div>
        <div className="mt-2 text-[11px] leading-relaxed text-ink-subtle">
          ⚠ 「一般回答を許可」を選ぶと、社内ドキュメントに基づかない回答が増えます。誤りを含みうる旨の注意喚起（F-30）はどちらの設定でも常時表示されます。
        </div>
      </div>

      <button
        type="button"
        disabled={saving}
        onClick={() => save()}
        className="rounded-lg bg-accent-600 px-4 py-2 text-[13px] font-bold text-white disabled:opacity-40"
      >
        保存
      </button>

      {previewTarget &&
        (() => {
          const kind = docPreviewKind(previewTarget.drive_folder_name)
          return (
            kind && (
              <DocPreviewModal
                previewUrl={`/api/channels/${channelId}/doc-folders/${previewTarget.id}/preview`}
                fileName={previewTarget.drive_folder_name}
                kind={kind}
                onClose={() => setPreviewTarget(null)}
              />
            )
          )
        })()}
    </div>
  )
}

// 反応モードタブ（A-24、F-15）。「投稿に自ら反応」の判定ロジックは設計書が規定していない
// （04_基本設計書.html 8.1節はグレーのまま）ため、ユーザーに確認のうえ「人間の投稿には必ず応答する」
// という最もシンプルな方式を採用した（追加のLLM呼び出しによる関連性判定はしない。
// services/ai_agent.py maybe_triggerを参照）。画面モックアップのカード型ラジオ（クリックで即選択・
// 即保存）を再現する。GeneralTabと同じA-24を呼び、自分が変更しない側（is_ai_enabled）は現在値のまま送る
function ReactionTab({
  channelId,
  settings,
  mutate,
}: {
  channelId: string
  settings: AiSettings
  mutate: () => Promise<AiSettings | undefined>
}) {
  const toast = useToast()
  const [saving, setSaving] = useState(false)

  const choose = async (mode: 'mention_only' | 'proactive') => {
    if (mode === settings.reaction_mode || saving) return
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/ai-settings/general`, {
        method: 'PUT',
        body: JSON.stringify({
          is_ai_enabled: settings.is_ai_enabled,
          reaction_mode: mode,
          ai_model: settings.ai_model,
        }),
      })
      await mutate()
      toast('反応モードを更新しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '変更に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  const personaName = settings.persona_name || 'Kogack AI'
  const reactionOptions: { value: 'mention_only' | 'proactive'; title: string; sub: string }[] = [
    {
      value: 'mention_only',
      title: 'メンション時のみ応答',
      sub: `「@${personaName}」と呼びかけられたときだけ応答します。会話に割り込みません。`,
    },
    {
      value: 'proactive',
      title: '投稿に自ら反応',
      sub: 'メンションがなくても、チャンネル内の投稿すべてにAIが自発的に反応します。',
    },
  ]

  return (
    <div className="max-w-[700px]">
      <p className="mb-5 text-[12.5px] leading-relaxed text-ink-muted">
        AIがどのタイミングで応答するかを設定します（F-15）。
      </p>
      <div className="space-y-2.5">
        {reactionOptions.map((opt) => (
          <RadioCard
            key={opt.value}
            title={opt.title}
            sub={opt.sub}
            selected={settings.reaction_mode === opt.value}
            onClick={() => choose(opt.value)}
            disabled={saving}
          />
        ))}
      </div>
      <MentionReminderSection channelId={channelId} settings={settings} mutate={mutate} />
    </div>
  )
}

const MENTION_REMINDER_HOURS = [1, 3, 6, 12, 24, 48, 72, 168]

const reminderHoursLabel = (h: number) => (h % 24 === 0 ? `${h / 24}日` : `${h}時間`)

// メンションの催促（A-77、2026-09-29。ユーザーからの明示的な要望「メンションを受けたのに一定時間
// たっても返信もリアクションもしていないユーザーに、AIが自動的に催促する機能」）。判定・投稿は
// backend/services/mention_reminder.py。反応モードと同じ「AIがいつ発言するか」の設定なのでこのタブに
// 同居させる。オン/オフ・待ち時間ともGeneralTabと同じく操作した瞬間に保存する
function MentionReminderSection({
  channelId,
  settings,
  mutate,
}: {
  channelId: string
  settings: AiSettings
  mutate: () => Promise<AiSettings | undefined>
}) {
  const toast = useToast()
  const [saving, setSaving] = useState(false)

  const save = async (enabled: boolean, hours: number, message: string) => {
    if (saving) return
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/ai-settings/mention-reminder`, {
        method: 'PUT',
        body: JSON.stringify({ enabled, hours }),
      })
      await mutate()
      toast(message)
    } catch (e) {
      toast(e instanceof Error ? e.message : '変更に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  const enabled = settings.mention_reminder_enabled
  const hours = settings.mention_reminder_hours
  // 選択肢に無い値（APIを直接呼んで設定した場合）もそのまま表示できるよう補う
  const hourOptions = MENTION_REMINDER_HOURS.includes(hours)
    ? MENTION_REMINDER_HOURS
    : [...MENTION_REMINDER_HOURS, hours].sort((a, b) => a - b)

  return (
    <div className="mt-8">
      <div className="mb-1.5 text-[13px] font-bold text-ink">メンションの催促</div>
      <p className="mb-3 text-[12.5px] leading-relaxed text-ink-muted">
        メンションされた人が一定時間たっても返信も絵文字リアクションもしていない場合に、AIが元の発言のスレッドで本人に催促します。催促は1件のメンションにつき1回だけです。
      </p>
      <label className="flex cursor-pointer items-center gap-3 rounded-[10px] border border-line bg-surface-subtle px-3.5 py-3">
        <span
          className={`relative h-[22px] w-[38px] flex-none rounded-full transition-colors ${
            enabled ? 'bg-accent-600' : 'bg-line-strong'
          }`}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={() =>
              save(!enabled, hours, enabled ? 'メンションの催促を無効にしました' : 'メンションの催促を有効にしました')
            }
            disabled={saving}
            className="sr-only"
          />
          <span
            className={`absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${
              enabled ? 'left-[18px]' : 'left-0.5'
            }`}
          />
        </span>
        <span>
          <div className="text-[13px] font-bold text-ink">反応の無いメンションをAIが催促する</div>
          <div className="mt-0.5 text-[11.5px] text-ink-subtle">
            有効にした時点より後のメンションが対象です。@channel・@hereは対象外です。
          </div>
        </span>
      </label>
      <div className="mt-3 rounded-[10px] border border-line bg-surface-subtle px-3.5 py-3">
        <label className="field-label mb-1.5 block text-[13px] font-bold text-ink">催促するまでの時間</label>
        <select
          value={hours}
          onChange={(e) => save(enabled, Number(e.target.value), '催促するまでの時間を更新しました')}
          disabled={saving}
          className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-ink"
        >
          {hourOptions.map((h) => (
            <option key={h} value={h}>
              メンションから{reminderHoursLabel(h)}後
            </option>
          ))}
        </select>
      </div>
      {enabled && !settings.is_ai_enabled && (
        <div className="mt-2 text-[11.5px] text-danger-text">
          このチャンネルではAIが無効のため、催促は行われません（基本設定タブでAIを有効にしてください）。
        </div>
      )}
    </div>
  )
}

// スキルの対応区分（A-28/A-29のresponse_level、2026-09-29の再設計）。「人が対応」はスキルではなく
// ②人に任せる依頼（A-31）の側で扱う。確認してから対応は、社内システムへの書き込み（F-24）・
// 実行前確認ダイアログ（F-25）ができるまでは、AIがチャット上で依頼者に確認してから進める
// （backend/services/ai_agent.py _build_skills_section）
const SKILL_LEVELS: { value: Skill['response_level']; title: string; sub: string }[] = [
  { value: 'auto', title: 'そのまま対応', sub: '依頼を受けたら、AIが手順どおりに進めます。' },
  {
    value: 'confirm',
    title: '確認してから対応',
    sub: 'AIがこれから行う内容を依頼者に示し、同意を得てから手順どおりに進めます。',
  },
]

// 「スキルと対応範囲設定」タブ（2026-09-29、ユーザーからの要望で旧「スキル」タブと旧「自動対応範囲」タブを
// 1つにまとめた）。同日、要求仕様書REQ-F-11（スキル＝AIの能力）・REQ-F-15（何をAIに任せるか）に
// 沿って「スキル＝AIに任せる業務」に1本化する再設計を行い、区分を「スキル（そのまま対応）／スキル
// （確認してから対応）／人に任せる依頼」の3つにした（要件定義書F-16改訂、基本設計書4.8節）。
// ①AIに任せる業務（スキル、A-28〜A-30） ②人に任せる依頼（A-31） ③引き継ぎ先（A-45）の順に並べる。
// 旧URL（?tab=skills・?tab=auto）はどちらもこのタブを開く
function TasksTab({
  channelId,
  settings,
  mutate,
}: {
  channelId: string
  settings: AiSettings
  mutate: () => Promise<AiSettings | undefined>
}) {
  return (
    <div className="max-w-[700px]">
      <p className="mb-6 text-[12.5px] leading-relaxed text-ink-muted">
        AIに任せる業務をスキルとして登録し（①）、AIに答えさせず人に任せる依頼を決めます（②）。どちらにも当てはまらない業務依頼や②の依頼は、③の引き継ぎ先へ相談するようAIが案内します。
      </p>
      <SectionHeading no="①" title="AIに任せる業務（スキル）" />
      <SkillsSection channelId={channelId} settings={settings} mutate={mutate} />
      <div className="mt-10" />
      <SectionHeading no="②" title="人に任せる依頼" />
      <AutoResponseSection channelId={channelId} settings={settings} mutate={mutate} />
      <div className="mt-10" />
      <SectionHeading no="③" title="引き継ぎ先" />
      <HandoffSection channelId={channelId} settings={settings} mutate={mutate} />
    </div>
  )
}

function SectionHeading({ no, title }: { no: string; title: string }) {
  return (
    <div className="mb-2.5 border-b border-line pb-1.5 text-[14px] font-bold text-ink">
      {no} {title}
    </div>
  )
}

// ②人に任せる依頼＝旧「自動対応範囲」タブ（A-31、F-16。TasksTabの一部）。2026-09-29の再設計で
// AIに任せる業務はスキル側へ移ったため、ここは「人が対応」の依頼だけを登録する一覧になった。
// 「人が対応」区分の判定方法は設計書が規定していない（グレー）ため、
// ユーザーに確認のうえ、区分一覧をシステムプロンプトに含めてAI自身に判断・引き継ぎさせる方式を
// 採用した（追加の分類LLM呼び出しはしない。services/ai_agent.py _build_auto_response_sectionを参照）。
// request_category（依頼内容）はチャンネル管理者が自由に追加・削除できる（画面モックアップの6例は
// 固定候補ではなく記入例）。APIは1回のPUTで一覧全体を洗い替える方式のままだが、画面は
// 「＋ 追加」「削除」「編集の確定」を押した瞬間にそのPUTを送る即保存にしている（2026-09-30、
// ユーザーからの要望。①スキル・③引き継ぎ先が即保存なのに②だけ「保存」ボタンを押すまで反映されず、
// 同じタブ内で保存のされ方がばらばらで分かりにくかったため揃えた）
function AutoResponseSection({
  channelId,
  settings,
  mutate,
}: {
  channelId: string
  settings: AiSettings
  mutate: () => Promise<AiSettings | undefined>
}) {
  const toast = useToast()
  const rules = settings.auto_response_rules
  const [newCategory, setNewCategory] = useState('')
  const [saving, setSaving] = useState(false)
  const [editingCategory, setEditingCategory] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')

  // 変更後の一覧全体をPUTして保存する。成功したらtrue（呼び出し側で入力欄を閉じる・空にする）
  const persist = async (next: AutoResponseRule[], message: string) => {
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/ai-settings/auto-response`, {
        method: 'PUT',
        body: JSON.stringify({ rules: next }),
      })
      await mutate()
      toast(message)
      return true
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存に失敗しました', 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  const removeRule = async (category: string) => {
    const ok = await persist(
      rules.filter((r) => r.request_category !== category),
      '人に任せる依頼を削除しました',
    )
    if (ok && editingCategory === category) setEditingCategory(null)
  }

  const addRule = async () => {
    const trimmed = newCategory.trim()
    if (!trimmed || saving) return
    if (rules.some((r) => r.request_category === trimmed)) {
      toast('同じ依頼内容が既に登録されています', 'error')
      return
    }
    const ok = await persist(
      [...rules, { request_category: trimmed, response_level: 'human' }],
      '人に任せる依頼を追加しました',
    )
    if (ok) setNewCategory('')
  }

  const startEdit = (category: string) => {
    setEditingCategory(category)
    setEditingValue(category)
  }

  const confirmEdit = async () => {
    if (editingCategory === null || saving) return
    const trimmed = editingValue.trim()
    if (!trimmed) {
      toast('依頼内容を入力してください', 'error')
      return
    }
    if (trimmed === editingCategory) {
      setEditingCategory(null)
      return
    }
    if (rules.some((r) => r.request_category === trimmed)) {
      toast('同じ依頼内容が既に登録されています', 'error')
      return
    }
    const ok = await persist(
      rules.map((r) => (r.request_category === editingCategory ? { ...r, request_category: trimmed } : r)),
      '人に任せる依頼を更新しました',
    )
    if (ok) setEditingCategory(null)
  }

  return (
    <div>
      <p className="mb-4 text-[12.5px] leading-relaxed text-ink-muted">
        ここに登録した種類の依頼には、AIは自分で答えず、引き継ぎ先（③）へ相談するよう案内します（F-16）。社内ドキュメントを見ればAIが答えられてしまう話題（個別の給与相談など）を、人に任せたいときに使います。
      </p>

      {rules.length === 0 ? (
        <p className="mb-5 text-[12px] text-ink-subtle">依頼の種類はまだ登録されていません。</p>
      ) : (
        <div className="mb-5 overflow-hidden rounded-[10px] border border-line-strong bg-surface shadow-[0_1px_3px_rgba(16,24,40,0.08)]">
          <table className="w-full text-left text-[12.5px]">
            <thead className="bg-surface-subtle text-[11px] text-ink-subtle">
              <tr>
                <th className="px-3.5 py-2 font-bold">依頼の種類</th>
                <th className="px-3.5 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rules.map((r) => {
                const isEditing = editingCategory === r.request_category
                return (
                  <tr key={r.request_category}>
                    <td className="px-3.5 py-2.5 text-ink">
                      {isEditing ? (
                        <input
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') confirmEdit()
                            if (e.key === 'Escape') setEditingCategory(null)
                          }}
                          maxLength={100}
                          autoFocus
                          className="w-full rounded-md border border-accent-600 px-2 py-1 text-[12.5px] text-ink outline-none focus:ring-4 focus:ring-accent-50"
                        />
                      ) : (
                        r.request_category
                      )}
                    </td>
                    <td className="px-3.5 py-2.5 text-right">
                      {isEditing ? (
                        <div className="flex justify-end gap-2.5">
                          <button
                            type="button"
                            disabled={saving}
                            onClick={confirmEdit}
                            className="text-[11px] font-semibold text-accent-700 hover:underline disabled:opacity-40"
                          >
                            確定
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingCategory(null)}
                            className="text-[11px] font-semibold text-ink-subtle hover:underline"
                          >
                            キャンセル
                          </button>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-2.5">
                          <button
                            type="button"
                            onClick={() => startEdit(r.request_category)}
                            className="text-[11px] font-semibold text-ink-muted hover:text-accent-700 hover:underline"
                          >
                            編集
                          </button>
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => removeRule(r.request_category)}
                            className="text-[11px] font-semibold text-danger-text hover:underline disabled:opacity-40"
                          >
                            削除
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mb-5 flex gap-2">
        <input
          value={newCategory}
          onChange={(e) => setNewCategory(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addRule()
          }}
          placeholder="例: 給与・人事評価の個別相談"
          maxLength={100}
          className="flex-1 rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
        <button
          type="button"
          disabled={saving}
          onClick={addRule}
          className="flex-none rounded-lg border border-line-strong px-3.5 py-2 text-[12.5px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700 disabled:opacity-40"
        >
          ＋ 追加
        </button>
      </div>

      <div className="text-[11px] leading-relaxed text-ink-subtle">
        どの依頼がどの種類に当てはまるかはAI自身が文章から判断するため、判断を誤ることがあります。絶対に答えさせたくない話題は「振る舞い定義」にも書いておくと確実です。
      </div>
    </div>
  )
}

// スキルの入力欄（新規作成パネル・編集モーダルの両方から使う共通の見た目。
// 定期投稿・トリガーのFormFieldsコンポーネントと同じ考え方）
function SkillFormFields({
  title, onTitleChange,
  instructions, onInstructionsChange,
  responseLevel, onResponseLevelChange,
}: {
  title: string
  onTitleChange: (v: string) => void
  instructions: string
  onInstructionsChange: (v: string) => void
  responseLevel: Skill['response_level']
  onResponseLevelChange: (v: Skill['response_level']) => void
}) {
  return (
    <>
      <div className="mb-3.5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">スキル名</label>
        <input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="例: 議事録の作成"
          maxLength={100}
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>
      <div className="mb-1">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">依頼を受けたときの進め方</label>
        <textarea
          value={instructions}
          onChange={(e) => onInstructionsChange(e.target.value)}
          rows={5}
          maxLength={4000}
          placeholder="例: 会議の発言ログを箇条書きで要約し、決定事項・次のアクションを最後にまとめる"
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] leading-relaxed text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>
      <div className="mt-3.5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">対応のしかた</label>
        <div className="space-y-2">
          {SKILL_LEVELS.map((lv) => (
            <RadioCard
              key={lv.value}
              title={lv.title}
              sub={lv.sub}
              selected={responseLevel === lv.value}
              onClick={() => onResponseLevelChange(lv.value)}
            />
          ))}
        </div>
      </div>
    </>
  )
}

// ①AIに任せる業務＝旧「スキル」タブ（A-28〜A-30、F-12・F-16。TasksTabの一部）。スキルごとに
// 対応区分（そのまま対応／確認してから対応）を持つ（2026-09-29の再設計）。定期投稿・
// トリガーと同じ「新規作成パネル＋編集モーダル」の構成。引き継ぎ先は①②の両方から使われるため
// HandoffSection（③）へ分けた
function SkillsSection({
  channelId,
  settings,
  mutate,
}: {
  channelId: string
  settings: AiSettings
  mutate: () => Promise<AiSettings | undefined>
}) {
  const toast = useToast()
  const confirm = useConfirm()
  const [editingItem, setEditingItem] = useState<Skill | null>(null)
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [responseLevel, setResponseLevel] = useState<Skill['response_level']>('auto')
  const [saving, setSaving] = useState(false)
  // 新規作成パネルは普段は閉じておき「＋ スキルを追加」で開く（2026-09-30、ユーザーからの要望。
  // 常に開いた空の記入欄が一覧の下に並び、②③が画面の下へ押しやられて分かりにくかったため）
  const [adding, setAdding] = useState(false)

  const closeAddPanel = () => {
    setAdding(false)
    setTitle('')
    setInstructions('')
    setResponseLevel('auto')
  }

  const submit = async () => {
    if (!title.trim() || !instructions.trim()) {
      toast('スキル名と進め方の両方を入力してください', 'error')
      return
    }
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/skills`, {
        method: 'POST',
        body: JSON.stringify({ title: title.trim(), instructions: instructions.trim(), response_level: responseLevel }),
      })
      toast('スキルを追加しました')
      await mutate()
      closeAddPanel()
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (skill: Skill) => {
    const ok = await confirm({
      title: 'スキルを削除',
      message: `「${skill.title}」を削除しますか？`,
      confirmLabel: '削除する',
      danger: true,
    })
    if (!ok) return
    try {
      await apiFetch(`/api/channels/${channelId}/skills/${skill.id}`, { method: 'DELETE' })
      await mutate()
      if (editingItem?.id === skill.id) setEditingItem(null)
      toast('スキルを削除しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '削除に失敗しました', 'error')
    }
  }

  return (
    <div>
      <p className="mb-4 text-[12.5px] leading-relaxed text-ink-muted">
        AIに任せる業務と、「依頼を受けたらこう進める」手順を登録します（F-12）。業務ごとに、そのまま対応するか、依頼者に確認してから対応するかを選べます（F-16）。スキルを1件でも登録すると、どのスキルにも当てはまらない業務依頼には、AIは「対応できません」と伝えて引き継ぎ先（③）を案内します。
      </p>

      <ul className="mb-6 space-y-2.5">
        {settings.skills.length === 0 && <p className="text-[12px] text-ink-subtle">スキルはまだありません。</p>}
        {settings.skills.map((skill) => (
          <li key={skill.id} className="rounded-[10px] border border-line-strong bg-surface px-3.5 py-3 shadow-[0_1px_3px_rgba(16,24,40,0.08)]">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-bold text-ink">{skill.title}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${
                  skill.response_level === 'confirm' ? 'bg-bot-bg text-bot-text' : 'bg-ok-bg text-ok-text'
                }`}
              >
                {skill.response_level === 'confirm' ? '確認してから対応' : 'そのまま対応'}
              </span>
            </div>
            <div className="mt-1.5 line-clamp-3 text-[12.5px] leading-relaxed text-ink-muted">{skill.instructions}</div>
            <div className="mt-2.5 flex justify-end gap-1.5">
              <button
                type="button"
                onClick={() => setEditingItem(skill)}
                className="rounded-md border border-line-strong px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700"
              >
                編集
              </button>
              <button
                type="button"
                onClick={() => remove(skill)}
                className="rounded-md border border-line-strong px-2.5 py-1 text-[11.5px] font-semibold text-danger-text hover:border-danger-border hover:bg-danger-bg"
              >
                削除
              </button>
            </div>
          </li>
        ))}
      </ul>

      {adding ? (
        <div className="rounded-[10px] border border-dashed border-line-strong bg-surface-subtle px-4 py-4">
          <div className="mb-3.5 text-[12.5px] font-bold text-ink">新しいスキル</div>
          <SkillFormFields
            title={title}
            onTitleChange={setTitle}
            instructions={instructions}
            onInstructionsChange={setInstructions}
            responseLevel={responseLevel}
            onResponseLevelChange={setResponseLevel}
          />
          <div className="mt-3.5 flex gap-2">
            <button
              type="button"
              disabled={saving}
              onClick={submit}
              className="rounded-lg bg-accent-600 px-4 py-2 text-[13px] font-bold text-white disabled:opacity-40"
            >
              追加
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={closeAddPanel}
              className="rounded-lg border border-line-strong px-4 py-2 text-[13px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700 disabled:opacity-40"
            >
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="rounded-lg border border-line-strong px-3.5 py-2 text-[12.5px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700"
        >
          ＋ スキルを追加
        </button>
      )}

      {editingItem && (
        <SkillEditModal
          key={editingItem.id}
          skill={editingItem}
          channelId={channelId}
          onClose={() => setEditingItem(null)}
          onSaved={mutate}
        />
      )}
    </div>
  )
}

// ③引き継ぎ先（A-45、F-17。TasksTabの一部）。②の人に任せる依頼と、①のどのスキルにも
// 当てはまらない業務依頼の両方で、AIが案内する相談先。参加者から選ぶセレクトのみのため、
// GeneralTabのトグルと同じく選択時に即保存する
function HandoffSection({
  channelId,
  settings,
  mutate,
}: {
  channelId: string
  settings: AiSettings
  mutate: () => Promise<AiSettings | undefined>
}) {
  const toast = useToast()
  const { members } = useChannelMembers(channelId)
  const [handoffSaving, setHandoffSaving] = useState(false)

  const changeHandoff = async (userId: string) => {
    setHandoffSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/ai-settings/handoff`, {
        method: 'PUT',
        body: JSON.stringify({ fallback_handoff_user_id: userId || null }),
      })
      await mutate()
      toast('引き継ぎ先を更新しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '更新に失敗しました', 'error')
    } finally {
      setHandoffSaving(false)
    }
  }

  return (
    <div>
      <p className="mb-2.5 text-[12.5px] leading-relaxed text-ink-muted">
        ②の人に任せる依頼と、①のどのスキルにも当てはまらない業務依頼を受けたときに、AIが案内する相談先です（F-17）。未指定の場合はこのチャンネルの管理者を案内します。指定した参加者が退出・無効化された場合は自動的に未指定へ戻ります。
      </p>
      <select
        value={settings.fallback_handoff_user_id ?? ''}
        onChange={(e) => changeHandoff(e.target.value)}
        disabled={handoffSaving}
        className="w-full max-w-[320px] rounded-lg border border-line-strong px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
      >
        <option value="">未指定（このチャンネルの管理者）</option>
        {members.filter((m) => m.is_active).map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.is_channel_admin ? '（chadmin）' : ''}
          </option>
        ))}
      </select>
    </div>
  )
}

// スキルの編集モーダル（一覧の「編集」から開く。定期投稿・トリガーの編集モーダルと同じパターン）
function SkillEditModal({
  skill, channelId, onClose, onSaved,
}: {
  skill: Skill
  channelId: string
  onClose: () => void
  onSaved: () => Promise<unknown>
}) {
  const overlayClose = useOverlayClose(onClose)
  const toast = useToast()
  const [title, setTitle] = useState(skill.title)
  const [instructions, setInstructions] = useState(skill.instructions)
  const [responseLevel, setResponseLevel] = useState<Skill['response_level']>(skill.response_level)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!title.trim() || !instructions.trim()) {
      toast('スキル名と進め方の両方を入力してください', 'error')
      return
    }
    setSaving(true)
    try {
      await apiFetch(`/api/channels/${channelId}/skills/${skill.id}`, {
        method: 'PUT',
        body: JSON.stringify({ title: title.trim(), instructions: instructions.trim(), response_level: responseLevel }),
      })
      toast('スキルを更新しました')
      await onSaved()
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : '保存に失敗しました', 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,24,33,0.45)] p-6" {...overlayClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-[480px] flex-col overflow-hidden rounded-[14px] bg-surface shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-[22px] pb-1 pt-4.5">
          <h2 className="flex-1 text-[15.5px] font-bold text-ink">スキルを編集</h2>
          <button type="button" onClick={onClose} className="text-ink-subtle hover:text-ink-muted">✕</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pb-1 pt-4.5">
          <SkillFormFields
            title={title}
            onTitleChange={setTitle}
            instructions={instructions}
            onInstructionsChange={setInstructions}
            responseLevel={responseLevel}
            onResponseLevelChange={setResponseLevel}
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
  if (item.frequency === 'weekdays') return `月〜金 ${time}`
  if (item.frequency === 'weekly') return `毎週 ${WEEKDAYS[d.getDay()]}曜 ${time}`
  if (item.frequency === 'month_end') return `毎月末 ${time}`
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

// 定期投稿・自動応答トリガーの本文欄。通常の投稿欄（Composer.tsx）をそのまま使う（ユーザーからの
// 要望「定期投稿・自動応答トリガーの本文欄を、通常の投稿欄と同じにしてほしい」。以前は記号を直接
// 挿入する素のtextarea＋メンションハイライト用オーバーレイだった）。書式は入力中にその場で反映され、
// 書式ボタンの押下状態の表示・リンク・絵文字（カスタム絵文字を含む）・「@」でのメンション候補も
// 投稿欄と同じ。メンション候補は@channel→チャンネルAI→参加者の順（ChannelView.tsxの
// mentionCandidatesWithAiと同じ考え方）。**@hereは対象外**（定期投稿・トリガーはあとで/自動で発火する
// BOT発言であり、「送信時点で今アクティブな人」という@hereの前提と相性が良くないため）。ファイル添付は
// 定期投稿・トリガーが対応していないためボタンを出さない。
// Composerは本文をDOMで保持する非制御の部品のため、フォーム側が本文を外から書き換える場合
// （追加後のリセット・チャンネル切り替え）は、フォーム側がresetKeyを変えて作り直させる
// （「受け取ったbodyが直前に通知した本文と違えば作り直す」という推測方式は、速く入力すると
// フォームの再描画より先に次の文字の通知が届いて誤って作り直し、入力中の文字が消えたため不採用）。
// bodyはマウント時の初期値としてだけ使う。
function BodyEditor({
  channelId, resetKey, body, onBodyChange, mentions, onMentionsChange, placeholder,
}: {
  channelId: string
  resetKey: number
  body: string
  onBodyChange: (v: string) => void
  mentions: MentionPayload[]
  onMentionsChange: (mentions: MentionPayload[]) => void
  placeholder: string
}) {
  const { members } = useChannelMembers(channelId)
  const { channel } = useChannel(channelId)
  const candidates: MentionCandidate[] = [
    { id: 'channel', name: 'channel', isChannel: true },
    ...(channel?.ai_is_enabled
      ? [{ id: 'ai', name: channel.ai_persona_name, isAi: true, picture_url: channel.ai_persona_icon_url } as MentionCandidate]
      : []),
    ...members.filter((m) => m.is_active),
  ]
  return (
    <Composer
      key={resetKey}
      placeholder={placeholder}
      initialBody={body}
      initialMentions={mentions}
      mentionCandidates={candidates}
      onChange={(nextBody, nextMentions) => {
        onBodyChange(nextBody)
        onMentionsChange(nextMentions)
      }}
      allowAttachments={false}
      autoFocus={false}
      popoverPlacement="below"
    />
  )
}

function RecurringPostFormFields({
  channelId, bodyResetKey = 0,
  displayName, onDisplayNameChange,
  emoji, onEmojiChange,
  iconUrl, onIconUrlChange,
  body, onBodyChange,
  mentions, onMentionsChange,
  frequency, onFrequencyChange,
  date, onDateChange,
  time, onTimeChange,
}: {
  channelId: string
  /** 本文欄を作り直す（フォームのリセット時に変える）ためのキー。BodyEditorのコメント参照 */
  bodyResetKey?: number
  displayName: string
  onDisplayNameChange: (v: string) => void
  emoji: string
  onEmojiChange: (v: string) => void
  iconUrl: string | null
  onIconUrlChange: (v: string | null) => void
  body: string
  onBodyChange: (v: string) => void
  mentions: MentionPayload[]
  onMentionsChange: (mentions: MentionPayload[]) => void
  frequency: 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'month_end'
  onFrequencyChange: (v: 'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'month_end') => void
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
          maxLength={50}
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>

      <IconInput emoji={emoji} onEmojiChange={onEmojiChange} iconUrl={iconUrl} onIconUrlChange={onIconUrlChange} />

      <div className="mb-3.5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">メッセージ本文</label>
        <BodyEditor
          channelId={channelId}
          resetKey={bodyResetKey}
          body={body}
          onBodyChange={onBodyChange}
          mentions={mentions}
          onMentionsChange={onMentionsChange}
          placeholder="投稿する内容を入力（本文中に「@」でメンション候補が開きます。「@ペルソナ名」を含めるとチャンネルAIも応答します）"
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
            <option value="weekdays">月〜金</option>
            <option value="weekly">毎週</option>
            <option value="monthly">毎月</option>
            <option value="month_end">月末</option>
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
        「毎週」は初回日時の曜日、「毎月」は初回日時の日にちで繰り返します（該当日が存在しない月は月末に送信）。「月〜金」は初回日時を起点に土日を飛ばして翌営業日へ繰り返します（初回自体は土日を指定しても構いません）。「月末」は初回日時の日にちに関わらず、以降は毎月最終日に送信します。「1回のみ」は指定日時に1度だけ投稿し、以降は自動的に一時停止扱いになります。
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
  const [mentions, setMentions] = useState<MentionPayload[]>([])
  const [displayName, setDisplayName] = useState('')
  const [emoji, setEmoji] = useState('📌')
  const [iconUrl, setIconUrl] = useState<string | null>(null)
  const [frequency, setFrequency] = useState<'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'month_end'>('weekly')
  const [date, setDate] = useState('')
  const [time, setTime] = useState('')
  const [saving, setSaving] = useState(false)
  const [bodyResetKey, setBodyResetKey] = useState(0)

  const resetForm = () => {
    setBodyResetKey((k) => k + 1)
    setBody('')
    setMentions([])
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
      const text = trimMessageBody(body)
      await apiFetch(`/api/channels/${channelId}/recurring-posts`, {
        method: 'POST',
        body: JSON.stringify({
          body: text,
          // 本文から手動で消されたメンションは除外する（Composer.tsxのactiveMentionsInと同じ
          // 整合性チェック。選択後に「@氏名」の文字列を手で削除した場合に、実体の無いメンションが
          // 送られてしまわないようにする）
          mentions: mentions.filter((m) => text.includes(`@${m.display_name_snapshot}`)),
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
          channelId={channelId}
          bodyResetKey={bodyResetKey}
          displayName={displayName}
          onDisplayNameChange={setDisplayName}
          emoji={emoji}
          onEmojiChange={setEmoji}
          iconUrl={iconUrl}
          onIconUrlChange={setIconUrl}
          body={body}
          onBodyChange={setBody}
          mentions={mentions}
          onMentionsChange={setMentions}
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
  const overlayClose = useOverlayClose(onClose)
  const toast = useToast()
  const initialAnchor = new Date(item.anchor_at)
  const [body, setBody] = useState(item.body)
  const [mentions, setMentions] = useState<MentionPayload[]>(item.mentions)
  const [displayName, setDisplayName] = useState(item.bot_display_name)
  const [emoji, setEmoji] = useState(item.bot_icon ?? '📌')
  const [iconUrl, setIconUrl] = useState<string | null>(item.bot_icon_url)
  const [frequency, setFrequency] = useState<'once' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'month_end'>(item.frequency)
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
      const text = trimMessageBody(body)
      await apiFetch(`/api/channels/${channelId}/recurring-posts/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          body: text,
          mentions: mentions.filter((m) => text.includes(`@${m.display_name_snapshot}`)),
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,24,33,0.45)] p-6" {...overlayClose}>
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
            channelId={channelId}
            displayName={displayName}
            onDisplayNameChange={setDisplayName}
            emoji={emoji}
            onEmojiChange={setEmoji}
            iconUrl={iconUrl}
            onIconUrlChange={setIconUrl}
            body={body}
            onBodyChange={setBody}
            mentions={mentions}
            onMentionsChange={setMentions}
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
  channelId, bodyResetKey = 0,
  triggerType, onTriggerTypeChange,
  triggerValue, onTriggerValueChange,
  actionBody, onActionBodyChange,
  mentions, onMentionsChange,
  displayName, onDisplayNameChange,
  emoji, onEmojiChange,
  iconUrl, onIconUrlChange,
}: {
  channelId: string
  /** 本文欄を作り直す（フォームのリセット時に変える）ためのキー。BodyEditorのコメント参照 */
  bodyResetKey?: number
  triggerType: 'keyword' | 'emoji'
  onTriggerTypeChange: (v: 'keyword' | 'emoji') => void
  triggerValue: string
  onTriggerValueChange: (v: string) => void
  actionBody: string
  onActionBodyChange: (v: string) => void
  mentions: MentionPayload[]
  onMentionsChange: (mentions: MentionPayload[]) => void
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
        <BodyEditor
          channelId={channelId}
          resetKey={bodyResetKey}
          body={actionBody}
          onBodyChange={onActionBodyChange}
          mentions={mentions}
          onMentionsChange={onMentionsChange}
          placeholder="トリガーに一致したときに投稿する内容を入力（本文中に「@」でメンション候補が開きます。「@ペルソナ名」を含めるとチャンネルAIも応答します）"
        />
      </div>

      <div className="mb-3.5">
        <label className="mb-1.5 block text-[12.5px] font-bold text-ink-muted">送り主の表示名</label>
        <input
          value={displayName}
          onChange={(e) => onDisplayNameChange(e.target.value)}
          placeholder="例: ヘルプ案内Bot"
          maxLength={50}
          className="w-full rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
        />
      </div>

      <IconInput emoji={emoji} onEmojiChange={onEmojiChange} iconUrl={iconUrl} onIconUrlChange={onIconUrlChange} />

      <div className="mb-3.5 text-[11px] leading-relaxed text-ink-subtle">
        人間の発言のみが判定対象で、BOT自身の投稿が別のトリガーを呼び出すことはありません。チャンネル本体の投稿のみが対象です（スレッド内の発言は対象外）。メンションを含めるとその相手への通知が届き、本文に「@{'{'}ペルソナ名{'}'}」を含めるとチャンネルAIも通常のメンションと同じように応答します。
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
  const [mentions, setMentions] = useState<MentionPayload[]>([])
  const [displayName, setDisplayName] = useState('')
  const [emoji, setEmoji] = useState('⚡')
  const [iconUrl, setIconUrl] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [bodyResetKey, setBodyResetKey] = useState(0)

  const resetForm = () => {
    setBodyResetKey((k) => k + 1)
    setTriggerType('keyword')
    setTriggerValue('')
    setActionBody('')
    setMentions([])
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
      const text = trimMessageBody(actionBody)
      await apiFetch(`/api/channels/${channelId}/trigger-rules`, {
        method: 'POST',
        body: JSON.stringify({
          trigger_type: triggerType,
          trigger_value: triggerValue.trim(),
          action_body: text,
          // 本文から手動で消されたメンションは除外する（recurring_posts.tsxのRecurringPostsTab.submit
          // と同じ整合性チェック）
          mentions: mentions.filter((m) => text.includes(`@${m.display_name_snapshot}`)),
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
          channelId={channelId}
          bodyResetKey={bodyResetKey}
          triggerType={triggerType}
          onTriggerTypeChange={setTriggerType}
          triggerValue={triggerValue}
          onTriggerValueChange={setTriggerValue}
          actionBody={actionBody}
          onActionBodyChange={setActionBody}
          mentions={mentions}
          onMentionsChange={setMentions}
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
  const overlayClose = useOverlayClose(onClose)
  const toast = useToast()
  const [triggerType, setTriggerType] = useState(item.trigger_type)
  const [triggerValue, setTriggerValue] = useState(item.trigger_value)
  const [actionBody, setActionBody] = useState(item.action_body)
  const [mentions, setMentions] = useState<MentionPayload[]>(item.mentions)
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
      const text = trimMessageBody(actionBody)
      await apiFetch(`/api/channels/${channelId}/trigger-rules/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          trigger_type: triggerType,
          trigger_value: triggerValue.trim(),
          action_body: text,
          mentions: mentions.filter((m) => text.includes(`@${m.display_name_snapshot}`)),
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,24,33,0.45)] p-6" {...overlayClose}>
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
            channelId={channelId}
            triggerType={triggerType}
            onTriggerTypeChange={setTriggerType}
            triggerValue={triggerValue}
            onTriggerValueChange={setTriggerValue}
            actionBody={actionBody}
            onActionBodyChange={setActionBody}
            mentions={mentions}
            onMentionsChange={setMentions}
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
