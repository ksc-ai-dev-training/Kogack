import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { useChannel, useChannels } from '../hooks/useChannels'
import { useChannelMembers } from '../hooks/useChannelMembers'
import { useMessages } from '../hooks/useMessages'
import { useUnreadDivider } from '../hooks/useUnreadDivider'
import { useMe } from '../hooks/useMe'
import { apiFetch, ApiError } from '../lib/api'
import MessageList from '../components/MessageList'
import Composer, { type MentionCandidate } from '../components/Composer'
import ThreadPanel from '../components/ThreadPanel'
import MembersModal from '../components/MembersModal'
import { useToast } from '../components/Toast'
import type { AttachmentPayload, MentionPayload } from '../types'

// S-03 チャンネル会話＋S-04 スレッド表示（このスライスは添付・送信予約は未実装）
export default function ChannelView() {
  const { channelId } = useParams<{ channelId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const threadId = searchParams.get('thread')
  // S-05横断検索の結果クリックでのハイライトジャンプ先（ユーザーからの明示的な要望）。
  // ?thread=も付いている場合はスレッド返信へのジャンプなので、本体タイムライン側は
  // アンカー取得しない（ThreadPanel側へ渡すことで、そちらのMessageListがハイライトする）
  const highlightId = searchParams.get('highlight')
  const { me } = useMe()
  const { channel, error: channelError } = useChannel(channelId)
  const { joined, mutate: mutateChannelsList } = useChannels()
  const { members } = useChannelMembers(channelId)
  // F-41 メンション候補。先頭は @channel（チャンネル全員への通知）・@here（送信時点でアクティブな
  // 参加者への通知）、次にチャンネルAI（有効なときだけ。画面モックアップS-03どおり。無効な
  // チャンネルでは「@ペルソナ名」と書いてもAIは応答しないため候補に出さない）、その後に参加者。
  // @channel・@here・AIメンションはいずれもID参照化しない（Composer.MentionCandidate の
  // isChannel / isHere / isAi 参照）。いずれもチャンネル会話のみ（スレッド返信・DMには出さない）。
  const mentionCandidatesWithAi: MentionCandidate[] = [
    { id: 'channel', name: 'channel', isChannel: true },
    { id: 'here', name: 'here', isHere: true },
    ...(channel?.ai_is_enabled
      ? [
          {
            id: 'ai',
            name: channel.ai_persona_name,
            isAi: true,
            picture_url: channel.ai_persona_icon_url,
          } as MentionCandidate,
        ]
      : []),
    ...members.filter((m) => m.is_active),
  ]
  // highlightIdがスレッド返信宛て（threadIdも同時に付いている）の場合は、返信自体ではなく
  // スレッドの元発言（threadId）を中心に本体タイムラインをアンカーする。ThreadPanelへ渡す
  // parentMessageはこの本体messagesから探す実装のため、元発言が直近読み込み分の外（古い発言）
  // だと見つからずnullになってしまう問題への対処。highlightIdが無い通常時（元々の「表示中の
  // 発言をクリックしてスレッドを開く」経路）は元の挙動のまま変更しない
  const anchorMessageId = highlightId ? (threadId ?? highlightId) : undefined
  const {
    messages, mutate: mutateMessages, bumpThreadReplyCount, removeMessage, decrementThreadReplyCount,
    updateMessageReactions,
  } = useMessages(channelId ? `/api/channels/${channelId}` : undefined, anchorMessageId)
  const unreadDividerMessageId = useUnreadDivider(
    channelId,
    joined.find((c) => c.id === channelId)?.unread_count,
    messages,
    me?.id,
  )
  const listRef = useRef<HTMLDivElement>(null)
  const [membersModalTab, setMembersModalTab] = useState<'info' | 'members' | null>(null)
  const [summarizing, setSummarizing] = useState(false)
  const toast = useToast()

  useEffect(() => {
    // 検索結果からのハイライトジャンプ中（本体タイムライン側、?thread=無し）は、MessageList側の
    // 「対象の発言までスクロール」と競合するため末尾への自動スクロールを止める（ユーザーからの
    // 明示的な要望で追加。無条件に末尾スクロールすると、直後に実行されるMessageListのscrollIntoView
    // を上書きしてしまい、常に末尾に戻ってしまう）
    if (highlightId && !threadId) return
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
    // バグ修正（2026-09-11）: 従来はmessages.lengthのみを依存配列にしていたため、AI応答が
    // 「生成中…」の短いプレースホルダとして追加された直後（length変化）はここで末尾へスクロール
    // するが、その後プレースホルダの本文が実際の長い回答へ更新される（同じ行の内容が変わるだけで
    // lengthは変化しない）タイミングではこの効果が再発火せず、スクロール位置が「生成中…」だった
    // 頃の高さのまま据え置かれてしまい、結果として長い回答の1行目だけが見えて続きは手動スクロール
    // が必要という不具合が発生していた（ユーザーからの報告）。最後のメッセージのupdated_at
    // （本文確定・生成完了時に必ず更新される、2026-09-04の同様の修正で確立済みの列）も依存配列に
    // 加え、本文が更新されたときにも再度末尾へスクロールするようにした。
  }, [messages.length, messages[messages.length - 1]?.updated_at, highlightId, threadId])

  useEffect(() => {
    // ハイライト表示は一時的なもの。数秒経ったら?highlight=をURLから外し、通常の
    // 「新着で末尾に自動スクロール」する状態に戻す（つけっぱなしだと、ジャンプ後に会話を
    // 続けていても新着に追従しなくなってしまう）。useMessages側はanchorMessageIdが
    // undefinedに変わっただけでは読み込み済みの内容を破棄しないため、消しても表示は消えない
    if (!highlightId) return
    const t = setTimeout(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete('highlight')
        return next
      }, { replace: true })
    }, 3000)
    return () => clearTimeout(t)
  }, [highlightId, setSearchParams])

  useEffect(() => {
    // このチャンネルを開いている間は既読として扱う（未読バッジ用。基本設計書4.2節「設計判断」）。
    // 表示中に新着が来た場合も追従して既読化するため、messages.lengthの変化でも発火させる。
    if (!channelId) return
    apiFetch(`/api/channels/${channelId}/read`, { method: 'POST' })
      .then(() => mutateChannelsList())
      .catch(() => {})
  }, [channelId, messages.length])

  if (channelError instanceof ApiError && (channelError.status === 404 || channelError.status === 403)) {
    // 総論5.9節: 404（存在しない・削除済み・非公開チャンネルの非参加者）と403（公開チャンネルの
    // 非参加者）を同じ文言で扱う。理由ごとに表示を出し分けると「削除済み」と「非公開で単に
    // 参加していないだけ」を利用者が区別できてしまい、F-34「非公開チャンネルは非参加者に
    // 存在自体を伏せる」設計が崩れるため、あえて一律の表示にする（バックエンドも両者を同じ
    // 404で返しており区別する情報を持たない）。文言は「削除されている」と断定せず「既に存在
    // しないか、参加権限がありません」の両論併記にした（ユーザーの指摘どおり、存在する非公開
    // チャンネルに対して「削除されています」と言い切るのは不正確なため。当初は「削除された
    // か、参加権限がありません」としていたが、2026-09-10にユーザーからの指摘で「既に存在
    // しないか」へ再度言い換えた——「削除された」は必ず過去に存在したことを含意してしまい、
    // そもそも存在しないチャンネルIDへのアクセスも同じ画面で扱う以上、より中立な表現を選んだ）。
    // 従来は無言でこの画面が空白のままだったが、削除済みチャンネルのURLへうっかりアクセス
    // した利用者に何のフィードバックも無く分かりづらいとの指摘を受け、明示的なメッセージに
    // 差し替えた（無言リダイレクトにはしない）
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center">
        <div className="text-[15px] font-bold text-ink">このチャンネルは既に存在しないか、参加権限がありません</div>
        <p className="max-w-[420px] text-[12.5px] leading-relaxed text-ink-subtle">
          このチャンネルは既に存在しないか、参加する権限がありません。心当たりがある場合はチャンネル管理者にご確認ください。
        </p>
        <Link
          to="/"
          className="mt-1.5 rounded-lg border border-line-strong px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700"
        >
          ← ワークスペースに戻る
        </Link>
      </div>
    )
  }
  if (channel && !channel.is_member) {
    // A-06はシステム管理者に限り非参加の非公開チャンネルでもメタデータを返す（S-06用の
    // 特例、auth_helpers.require_channel_member_or_adminを参照）が、発言本文を返すA-10は
    // 引き続き参加者限定のまま。この画面（S-03）自体は開けても会話内容だけが見えない
    // 中途半端な状態になる。上のchannelError（404/403、F-34「存在を伏せる」対象）とは異なり、
    // ここに来る時点でA-06自体は成功しておりチャンネルの存在・名前は既にadminへ開示済み
    // （S-08管理コンソールのリンク経由等）なので、伏せる理由が無い。単に空白のメイン画面に
    // なるだけでは「何が起きたか分かりづらい」というユーザー指摘を受け、参加していない旨を
    // 明示するメッセージに差し替えた（無言リダイレクトにはしない）
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center">
        <div className="text-[15px] font-bold text-ink">
          {channel.is_public ? '#' : '🔒'} {channel.name} には参加していません
        </div>
        <p className="max-w-[420px] text-[12.5px] leading-relaxed text-ink-subtle">
          このチャンネルの参加者ではないため、会話内容は表示できません。閲覧するには、このチャンネルの参加者に追加してもらう必要があります。
        </p>
        <Link
          to={`/channels/${channelId}/settings`}
          className="mt-1.5 rounded-lg border border-line-strong px-3.5 py-1.5 text-[12.5px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700"
        >
          ⚙ チャンネル設定を開く
        </Link>
      </div>
    )
  }

  const openThread = (messageId: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('thread', messageId)
      return next
    })
  }
  const closeThread = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('thread')
      return next
    })
  }

  // A-15: チャンネル本体の要約（F-14）。押した時点までの直近100件を対象に、要約結果は
  // このチャンネルへのAI発言として投稿される（生成中はMessageListが「生成中」を表示するため、
  // ここでは投稿完了を待たずすぐにボタンを元に戻す。mutateMessages()は3秒ポーリングを待たず
  // プレースホルダ行を早く表示するための一手）
  const summarize = async () => {
    if (!channelId) return
    setSummarizing(true)
    try {
      await apiFetch(`/api/channels/${channelId}/summarize`, { method: 'POST', body: JSON.stringify({}) })
      await mutateMessages()
    } catch (e) {
      toast(e instanceof Error ? e.message : '要約に失敗しました', 'error')
    } finally {
      setSummarizing(false)
    }
  }

  return (
    <div className="flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[52px] flex-none items-center gap-2.5 border-b border-line px-5">
          <span className="text-base text-ink-subtle">{channel?.is_public === false ? '🔒' : '#'}</span>
          <span
            onClick={channel ? () => setMembersModalTab('info') : undefined}
            className={`min-w-0 flex-shrink truncate text-[15px] font-bold text-ink ${channel ? 'cursor-pointer hover:underline' : ''}`}
          >
            {channel?.name ?? '読み込み中...'}
          </span>
          {channel?.topic && (
            <span className="ml-1 min-w-0 max-w-[220px] flex-shrink truncate text-xs text-ink-subtle">
              {channel.topic}
            </span>
          )}
          {channel && (
            <button
              type="button"
              onClick={() => setMembersModalTab('members')}
              className="ml-auto flex-none rounded-[7px] border border-line px-2.5 py-1 text-xs font-semibold text-ink-muted hover:border-line-strong hover:bg-surface-subtle"
            >
              👥 所属メンバー：{channel.member_count}人
            </button>
          )}
          {channel && (
            <button
              type="button"
              disabled={summarizing}
              onClick={summarize}
              title="押した時点までの直近100件を要約します（F-14）"
              className="flex-none rounded-[7px] border border-accent-100 bg-accent-50 px-2.5 py-1 text-xs font-semibold text-accent-700 hover:bg-accent-100 disabled:opacity-50"
            >
              📝 {summarizing ? '要約中...' : '要約'}
            </button>
          )}
          {(channel?.is_channel_admin || me?.role === 'admin') && (
            <Link
              to={`/channels/${channelId}/settings`}
              className="flex-none rounded-[7px] border border-line px-2.5 py-1 text-xs font-semibold text-ink-muted hover:border-line-strong hover:bg-surface-subtle"
            >
              ⚙ チャンネル設定
            </Link>
          )}
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-3">
          <MessageList
            messages={messages}
            emptyMessage="まだ発言がありません。最初のメッセージを送ってみましょう。"
            onOpenThread={openThread}
            openThreadId={threadId}
            onDeleted={removeMessage}
            onReactionToggled={updateMessageReactions}
            members={members}
            unreadDividerMessageId={unreadDividerMessageId}
            aiPersonaName={channel?.ai_persona_name}
            highlightMessageId={highlightId}
          />
        </div>

        <div className="flex-none border-t border-line px-5 py-2.5">
          <Composer
            placeholder={`# ${channel?.name ?? ''} にメッセージを送る（@でメンション）`}
            mentionCandidates={mentionCandidatesWithAi}
            aiPersonaName={channel?.ai_persona_name}
            scheduleTarget={{ channel_id: channelId }}
            onSend={async (body, mentions: MentionPayload[], attachments: AttachmentPayload[]) => {
              if (!channelId) return
              await apiFetch(`/api/channels/${channelId}/messages`, {
                method: 'POST',
                body: JSON.stringify({ body, mentions, attachments }),
              })
              await mutateMessages()
            }}
          />
        </div>
      </div>

      {threadId && (
        <ThreadPanel
          messageId={threadId}
          parentMessage={messages.find((m) => m.id === threadId) ?? null}
          headerSub={`# ${channel?.name ?? ''}`}
          members={members}
          aiPersonaName={channel?.ai_persona_name}
          aiIsEnabled={channel?.ai_is_enabled}
          aiPersonaIconUrl={channel?.ai_persona_icon_url}
          highlightMessageId={highlightId}
          onClose={closeThread}
          onReplyPosted={() => bumpThreadReplyCount(threadId)}
          onReplyDeleted={() => decrementThreadReplyCount(threadId)}
        />
      )}

      {membersModalTab && channelId && (
        <MembersModal
          channelId={channelId}
          initialTab={membersModalTab}
          onClose={() => setMembersModalTab(null)}
        />
      )}
    </div>
  )
}
