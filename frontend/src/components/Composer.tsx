import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { avatarColorFor } from '../lib/avatarColor'
import { apiFetch, uploadAttachment } from '../lib/api'
import { getDraft, setDraft } from '../lib/drafts'
import { useCustomEmoji } from '../hooks/useCustomEmoji'
import { AddCustomEmojiModal } from './AddCustomEmojiModal'
import { CreatePollModal } from './CreatePollModal'
import { useToast } from './Toast'
import {
  domToPlainText,
  domToMarkdown,
  closeDanglingCodeFence,
  deserializeFromText,
  getSelectionOffsets,
  setSelectionOffsets,
  replaceRangeWithText,
  replaceRangeWithMentionSpan,
  insertTextAfterNode,
  insertAtomicEmojiAtCursor,
  tryConvertJustCompletedShortcode,
  enforceMaxLength,
  removeStrayEmptyBr,
  normalizeInvariants,
  ensureTrailingNewlineCaretMarker,
  removeCaretMarkerFromDom,
  scrollCaretIntoView,
  syncLiveFormatting,
  wrapRangeInFormats,
  wrapRangeAsCodeBlock,
  toggleFormatAtCursorDom,
  toggleFormatOnSelectionDom,
  isCursorInsideActiveFormats,
  getBlockFormatAt,
  getInlineCodeElementAt,
  convertLinesToListItems,
  ungroupListElement,
  handleEnterInListItem,
  handleBackspaceAtListItemStart,
  computeElementOffset,
  type ToggleFormatKind,
} from '../lib/composerEditing'
import type { AttachmentPayload, MentionPayload, ScheduleTarget } from '../types'

const MIN_ROWS = 2
const MAX_ROWS = 10
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024 // 20MB（F-07、05-1_詳細設計書_DB設計.html 3.6節）
const MAX_BODY_LENGTH = 4000

// 絵文字入力ボタン（ユーザーからの明示的な要望「Slackのように絵文字入力ボタンをメンションの
// 横につけたい」）。フルの絵文字ピッカーライブラリは導入せず、業務チャットでよく使う絵文字を
// 一覧から選んで挿入するだけの簡易版にした（検索・カテゴリ分け・スキントーン切替は対象外）。
// メッセージへの絵文字リアクション（MessageList.tsx・ThreadPanel.tsx、2026-09-10追加）でも
// 同じ一覧を再利用するためexportする（2箇所で別々の絵文字セットを持つと選べる絵文字が
// 画面によって違うという分かりにくさが生まれるため、単一のソースにした）
export const EMOJI_LIST = [
  '😀', '😄', '😅', '😂', '🙂', '😉', '😊', '😍', '🥰', '😘',
  '😎', '🤔', '😮', '😢', '😭', '😡', '🥳', '😴', '🤗', '🙄',
  '👍', '👎', '👏', '🙏', '💪', '🙌', '✌️', '🤝', '👋', '✍️',
  '❤️', '💛', '💚', '💙', '💜', '🧡', '🖤', '💔', '💯', '✨',
  '✅', '❌', '⚠️', '❓', '❗', '🔥', '🎉', '🎊', '🎁', '🚀',
  '📌', '📅', '⏰', '💡', '🙇', '🙇‍♂️', '🙇‍♀️', '😇', '👀', '🤞',
]

export interface MentionCandidate {
  id: string
  name: string
  /** チャンネルAI（F-41、候補一覧の先頭に表示）。AIメンションはF-41の人間宛と異なりID参照化しない
   * （基本設計書5.22節）ため、選択してもmentions配列には追加せず本文への挿入のみ行う */
  isAi?: boolean
  /** @channel（チャンネル全員への通知）。選択するとmentions配列へkind='channel'のエントリを
   * 追加し、本文には「@channel」を挿入する。チャンネル会話でのみ候補に含める（DM・スレッド返信では出さない）。 */
  isChannel?: boolean
  /** @here（送信時点でアクティブだった参加者への通知）。選択するとmentions配列へkind='here'の
   * エントリを追加し、本文には「@here」を挿入する。@channelと同様チャンネル会話でのみ候補に含める。 */
  isHere?: boolean
  /** プロフィール画像URL（未設定時はnull/undefined）。実際に発言したときのAvatar（MessageList.tsx）
   * と同じく画像優先→無ければ色付き頭文字にフォールバックする（ユーザーからの指摘で追加。
   * 従来は候補一覧が常に色付き頭文字のみで、発言時のアイコンと一致していなかった） */
  picture_url?: string | null
}

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// 送信予約ポップオーバーを開いたときの日時欄の既定値（F-35）。5分後を初期値にし、
// 「未来の日時を指定してください」のバリデーションに即座に引っかからないようにする。
function defaultScheduleDateTime(): { date: string; time: string } {
  const d = new Date(Date.now() + 5 * 60 * 1000)
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  }
}

// 「@」（全角「＠」も同様に扱う。IME入力時に全角になりやすいため）の直後、空白を挟まずカーソルまで
// 続く文字列をメンション候補の絞り込みクエリとして検出する（F-41）。入力欄の冒頭や直前の文字に
// 関わらず、「@」を入力した瞬間に候補を表示する（ユーザーからの要望。以前は直前が空白または
// 本文の先頭のときのみ検出していたが、文中の任意の位置でもメンションできるよう緩和した）。
// ChannelSettings.tsx（S-06定期投稿/トリガーの素の<textarea>）が今もこの関数をここから
// importして使っているため、シグネチャ・純粋な文字列関数という性質は変更しない。
export function detectMentionQuery(text: string, cursor: number): { atIndex: number; query: string } | null {
  const uptoCursor = text.slice(0, cursor)
  const atIndex = Math.max(uptoCursor.lastIndexOf('@'), uptoCursor.lastIndexOf('＠'))
  if (atIndex === -1) return null
  const query = uptoCursor.slice(atIndex + 1)
  if (/[\s\n]/.test(query)) return null
  return { atIndex, query }
}

// メンションハイライトの範囲検出（本文中のdisplay_name_snapshot・AIペルソナ名の出現箇所）。
// ChannelSettings.tsx（S-06定期投稿/トリガーの素の<textarea>、透明textarea＋オーバーレイ方式を
// 今も使っている）が今もこの関数をここからimportして使っているため、シグネチャ・純粋な文字列
// 関数という性質は変更しない。Composer.tsx自身は2026-09-18のcontentEditable化後、この関数を
// 継続的な全文再スキャンには使わなくなった（メンションは挿入時点でハイライトspanを直接
// DOMへ埋め込む方式に変更したため。詳細はcomposerEditing.tsのコメント参照）が、外部契約を
// 壊さないためエクスポートはそのまま残す。
export function findMentionHighlights(
  text: string,
  mentions: MentionPayload[],
  aiPersonaName?: string,
): { start: number; end: number }[] {
  const matches: { start: number; end: number }[] = []
  for (const m of mentions) {
    const needle = `@${m.display_name_snapshot}`
    const idx = text.indexOf(needle)
    if (idx !== -1) matches.push({ start: idx, end: idx + needle.length })
  }
  if (aiPersonaName) {
    const needle = `@${aiPersonaName}`
    let idx = text.indexOf(needle)
    while (idx !== -1) {
      matches.push({ start: idx, end: idx + needle.length })
      idx = text.indexOf(needle, idx + needle.length)
    }
  }
  matches.sort((a, b) => a.start - b.start)
  return matches
}

// S-03・S-04共通の投稿欄（詳細設計書 画面設計11.3節）。呼び出し元はAPI呼び出し（A-11/A-14/A-19）
// とmutate()だけを担い、送信中状態・エラートーストはこちらで一元管理する。
// mentionCandidatesを渡すと「@」入力でF-41のオートコンプリートが有効になる（チャンネル会話のみ。
// DM会話では候補元＝A-46がチャンネル専用のため渡さない）。
// scheduleTargetを渡すとF-35の送信予約ボタンが有効になる（チャンネル・DM・スレッド返信いずれも
// 対応。送信予約自体はComposerがA-50を直接呼ぶ。設計書のComposerがchannelId/threadParentIdを
// 直接受け取る想定とは異なり、このアプリの実装はonSendコールバック方式のため、送信予約専用に
// 送信先だけを渡す形にしている）。
// ファイル添付（F-07）はメンション候補の有無・送信予約対応の有無に関わらず常に使える（チャンネル・
// DM・スレッド返信いずれもA-21/A-22は候補元に依存しないため）。ただし送信予約では利用できない
// （confirmScheduleでattachmentsが1件以上あれば拒否する。基本設計書6.2節「設計判断」）。
//
// 実装方式（2026-09-18、ユーザーからの明示的な要望「カスタム絵文字を普通の絵文字のように1文字
// として扱いたい」による全面書き換え）: 従来の「透明textarea＋背後オーバーレイ」方式では、
// 見た目は画像に差し替えても実際のtextareaには`:aurora:`という生テキストがそのまま残っており、
// カーソル移動・Backspace・クリック位置決めのすべてが8文字ぶん動くという違和感があった。
// これをcontentEditableな<div>へ書き換え、カスタム絵文字だけを`contenteditable="false"`の
// 原子img要素として実際にDOM上へ埋め込む（メンションはプレーンテキストのまま、選択・確定した
// 瞬間だけハイライトspanで囲む——継続的な全文再スキャンをしないことで、自前contentEditable
// 実装で最もバグりやすい「入力のたびにスタイル付きノードをDOMツリー全体で差分再構築する」
// 処理を避ける設計判断。詳細はlib/composerEditing.tsの冒頭コメント参照）。
// body: stringというReact stateは廃止し、送信・下書き保存・メンション検出はいずれも
// domToPlainText(editorRef.current)をその場で呼ぶ（唯一の真実の情報源はDOM自体）。
export default function Composer({
  placeholder,
  onSend,
  mentionCandidates,
  aiPersonaName: _aiPersonaName,
  scheduleTarget,
  draftKey,
  onCreatePoll,
}: {
  placeholder: string
  onSend: (body: string, mentions: MentionPayload[], attachments: AttachmentPayload[]) => Promise<void>
  mentionCandidates?: MentionCandidate[]
  /** 入力中のAIメンションのハイライト用（チャンネルAIのpersona_name）。以前はfindMentionHighlights
   * による全文再スキャンでこの値を使ってハイライトしていたが、2026-09-18のcontentEditable化で
   * メンションは挿入時点のみハイライトする方式へ変更したため、AI候補選択時のハイライトは
   * MentionCandidate.isAi自体から直接行うようになり、この値自体は現在使用していない。
   * 呼び出し元（ChannelView.tsx・ThreadPanel.tsx）との既存props契約を壊さないためprop自体は
   * 残す（未使用であることが分かるよう`_aiPersonaName`として受け取る）。 */
  aiPersonaName?: string
  scheduleTarget?: ScheduleTarget
  /** 下書きの永続化キー（lib/drafts.ts。チャンネルは`c:<id>`、DMは`d:<id>`、スレッドは`t:<messageId>`）。
   * 未指定時は下書きを保存・復元しない。呼び出し元は会話が変わるたびComposerをkey propで
   * 再マウントする実装（2026-09-14）のため、このpropもそのたびに新しい値で初期状態から始まる */
  draftKey?: string
  /** アンケート作成（ユーザーからの明示的な要望「アンケート機能を付けてほしい」、2026-09-18）。
   * 指定された場合のみ投稿欄に📊ボタンを表示する。V1スコープはチャンネル・DM本体の投稿のみ
   * （ThreadPanel.tsxはこのpropを渡さず、スレッド返信からの作成は対象外のまま）。 */
  onCreatePoll?: (question: string, options: string[]) => Promise<void>
}) {
  const [sending, setSending] = useState(false)
  const [hasContent, setHasContent] = useState(false)
  const [mentions, setMentions] = useState<MentionPayload[]>(() => (draftKey ? getDraft(draftKey).mentions : []))
  const [attachments, setAttachments] = useState<AttachmentPayload[]>([])
  const [uploading, setUploading] = useState(false)
  const [pickerQuery, setPickerQuery] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [showAddEmojiModal, setShowAddEmojiModal] = useState(false)
  const [showPollModal, setShowPollModal] = useState(false)
  const { customEmoji, isLoading: customEmojiLoading, mutate: mutateCustomEmoji } = useCustomEmoji()
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')
  const [scheduling, setScheduling] = useState(false)
  // 下書き永続化を発火させるためだけの軽量なカウンタ（bodyという文字列stateを持たなくなったため、
  // DOMの内容が変わったことをuseEffectへ伝える最小限のトリガーとして使う。mentions配列は
  // React state自体を依存に含めているため、mentions変化時は素直に再実行される）
  const [contentVersion, setContentVersion] = useState(0)
  // リンク挿入ポップアップ（ユーザーからの明示的な要望「スラックみたいに、リンクもボタンを
  // 押したら、テキストとリンクを設定する画面ポップアップが出てきてほしい」）。ボタン自体は
  // onMouseDown+preventDefaultでcontentEditableのフォーカス（＝選択範囲）を失わせないため、
  // 開いた時点の選択範囲をオフセットとしてrefへ退避しておく必要は無くなった…と思いきや、
  // ポップアップ内のテキスト/URL入力欄は実際に入力するため本物のフォーカスが必要で、
  // その時点でcontentEditableの選択は失われる。そのため引き続き開いた瞬間の選択範囲を
  // オフセットとして退避しておき、確定時にその範囲を置き換える。
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkText, setLinkText] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const linkSelectionRef = useRef({ start: 0, end: 0 })
  const toast = useToast()
  const editorRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sendingRef = useRef(false)
  const emojiPopoverRef = useRef<HTMLDivElement>(null)
  const activeCandidateRef = useRef<HTMLButtonElement>(null)
  // 下書き復元直後、まだcustomEmojiの読み込み（非同期SWR）が完了していない場合に:name:が
  // プレーンテキストのまま残る問題への対処（詳細はcustomEmojiのuseEffect参照）。利用者が
  // 既に編集を始めていたら追いかけ変換で上書きしないためのフラグ。afterMutate()（ユーザー
  // 操作起点の変更）でのみtrueにし、マウント時の下書き復元自体では立てない。
  const hasUserEditedRef = useRef(false)
  const emojiCatchUpAppliedRef = useRef(false)
  // 書式トグルボタン（太字・斜体・下線・取り消し線、ユーザーからの明示的な要望「ボタンが押されて
  // いる間はその記法になり、もう一度押すと解除される仕組みにしてほしい（Wordみたいな感じ）」）の
  // 現在の押下状態。activeFormats＝実際にマーカーが本文にすでに挿入済み（＝既に何か入力済み）の
  // 書式。カーソル位置に対する見た目上のヒントに過ぎず（詳細はcomposerEditing.tsの冒頭コメント
  // 参照）、テキスト自体は常にその場で完全なMarkdownとして存在する。
  const [activeFormats, setActiveFormats] = useState<ToggleFormatKind[]>([])
  // pendingFormats＝ボタンは押されているが、まだ1文字も入力されていないため本文には一切
  // 挿入していない書式（ユーザーからの報告「記法のボタン押すと一文字分見えない何かが入力される
  // のやめてほしい」への対応）。以前はボタンを押した瞬間に空の開始・終了マーカー対を即座に本文へ
  // 挿入していた（文字色を透明にして隠していても、実際には「空だが実在する」書式が本文中に
  // 存在していた）。次にmaterializePendingFormats（下記）が実際に入力された文字を検知した時点で
  // 初めてマーカーを挿入するよう変更し、それまでは本文・DOMに一切触れない。
  const [pendingFormats, setPendingFormats] = useState<ToggleFormatKind[]>([])
  // materializePendingFormatsが「今回の入力で何文字増えたか」を判定するための、直前の
  // 書式同期後（refreshEditorHousekeeping末尾）の本文文字数。IME合成中（skipLiveFormatSync）は
  // 更新しない——合成の途中経過ごとに更新すると、合成が確定した時点で「合成開始前からの
  // 増加分」ではなく「合成の最後の1コマからの増加分」しか測れなくなるため。
  const prevPlainTextLengthRef = useRef(0)

  const canSchedule = !!(scheduleTarget?.channel_id || scheduleTarget?.dm_id)

  const filteredCandidates = (mentionCandidates ?? []).filter((c) =>
    c.name.toLowerCase().includes((pickerQuery ?? '').toLowerCase()),
  )
  const pickerOpen = pickerQuery !== null && filteredCandidates.length > 0

  // 十字キーでactiveIndexが枠外の候補まで進んだ際、選択中の項目が見えなくなるバグへの対処
  // （ユーザーからの報告）。ブラウザネイティブのスクロールに追従を任せるのではなく、
  // activeIndexが変わるたびに選択中のボタンをscrollIntoViewで確実に可視範囲へ収める。
  useEffect(() => {
    if (pickerOpen) {
      activeCandidateRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [pickerOpen, activeIndex])

  // オートリサイズ（MIN_ROWS〜MAX_ROWSまでは入力に合わせて高さを広げ、超えたらスクロール）。
  // 旧実装はbody state変化に反応するuseLayoutEffectだったが、bodyというReact stateを
  // 廃止したため、このタイミングで同期的に直接呼ぶ形にした（むしろuseLayoutEffectの依存配列
  // タイミング問題を気にしなくてよくなり単純化した）。resizeでel.style.height='auto'にすると
  // 一瞬scrollTopがリセットされる既知の挙動（過去のバグ修正コメント参照）は変わらず存在するため、
  // 保存→復元は引き続き必要。
  //
  // バグ修正（ユーザーからの報告「Enterを押して11行目以降になると、改行するたびに下の行が
  // 画面に見えなくなり、一行増えるたびにスクロールして表示させなければならない」）: 上記の
  // prevScrollTop保存→復元は「リサイズ自体で起きる望まない位置ずれ」を防ぐためのものだが、
  // これをそのまま復元するだけでは、新しく増えた行（キャレットの位置）がスクロール範囲の
  // 外に隠れたままになってしまう。scrollCaretIntoView（composerEditing.ts）でキャレットの
  // 実際の位置を確認し、必要な分だけさらにスクロールを追従させる（textareaがブラウザ標準で
  // 行っていた「キャレット追従スクロール」の自前実装）。11行目以降がスクロールになること
  // 自体は既存の仕様のまま維持する（MAX_ROWSは変更しない）。
  const resizeEditor = () => {
    const el = editorRef.current
    if (!el) return
    const style = window.getComputedStyle(el)
    const lineHeight = parseFloat(style.lineHeight) || 20
    const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const minHeight = lineHeight * MIN_ROWS + paddingY
    const maxHeight = lineHeight * MAX_ROWS + paddingY
    const prevScrollTop = el.scrollTop
    el.style.height = 'auto'
    const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
    el.scrollTop = prevScrollTop
    scrollCaretIntoView(el)
  }

  // マウント時1回だけ下書きを復元する（Composerは会話が変わるたびkey propで再マウントされる
  // 既存設計、2026-09-14）。useLayoutEffectにするのは、復元前の空表示・復元後の高さ再計算前の
  // 状態が一瞬でも画面に見えてしまうのを防ぐため（既存のリサイズ処理と同じ理由）。
  useLayoutEffect(() => {
    const root = editorRef.current
    if (!root) return
    if (draftKey) {
      const draft = getDraft(draftKey)
      if (draft.body) root.replaceChildren(deserializeFromText(draft.body, customEmoji))
    }
    // setHasContent+resizeEditorを直接呼ぶのではなくrefreshEditorHousekeeping経由にする
    // （バグ修正: 直接呼んでいた当時はここが書式のライブプレビュー同期を経由せず、復元直後の
    // 下書きに「**太字**」等が含まれていてもリロード直後は装飾なしのプレーンテキストのまま
    // 表示され、次の1文字入力まで反映されない不具合があった。実機Playwrightで発見・修正）
    refreshEditorHousekeeping()
    // マウント時に1回だけ実行する（draftKey・customEmojiは意図的に依存から外している。
    // customEmojiが後から読み込まれた場合の追いかけ変換は下のuseEffectで別途行う）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // バグ予防（Planサブエージェントによる設計精査で指摘された懸念）: customEmoji一覧は非同期
  // （SWR）で読み込まれるため、マウント時点の下書き復元（上のuseLayoutEffect）がまだ空の
  // customEmojiで実行されると、その時点で解決できなかった`:aurora:`等のショートコードは
  // プレーンテキストのまま残ってしまう。旧実装（textarea＋オーバーレイ）はcustomEmojiが
  // 読み込まれるたびに自動的に全文再スキャンしていたため自己修復していたが、新実装は
  // 継続的な再スキャンをしない設計のため、customEmojiの読み込みが完了した瞬間に一度だけ
  // 追いかけ変換を行う（ただし、その間に利用者が既に編集を始めていたら上書きしない）。
  useEffect(() => {
    if (emojiCatchUpAppliedRef.current) return
    if (customEmojiLoading) return
    emojiCatchUpAppliedRef.current = true
    if (hasUserEditedRef.current) return
    const root = editorRef.current
    if (!root || !draftKey) return
    // バグ修正（実機Playwright検証で発見）: ここは「現在のDOMをテキストとして読み直し、
    // 絵文字ショートコード解釈ありで再構築する」処理のため、domToPlainTextではなく
    // domToMarkdownを使う必要がある——domToPlainTextは太字・斜体・下線・取り消し線の
    // 実要素を素通りしてプレーンテキストへ変換する（マーカー文字を含まない）ため、これで
    // 再構築すると、直前のマウント時useLayoutEffectがsyncLiveFormattingで正しく構造化した
    // <strong>等がここで消え、装飾の無いプレーンテキストへ戻ってしまっていた。
    const currentText = domToMarkdown(root)
    if (!currentText) return
    root.replaceChildren(deserializeFromText(currentText, customEmoji))
    refreshEditorHousekeeping()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customEmojiLoading])

  // 下書きの永続化（ユーザーからの明示的な要望）。setBodyという単一の変更点が無くなったため、
  // 「内容が変わったことを示す軽量なカウンタ」contentVersionと、React stateのままのmentionsを
  // 依存にしたuseEffectで代替する。実行時は常にeditorRef.currentから最新のDOMを直接読み直す
  // ため、古い値を参照してしまう心配が無い（送信・送信予約成功後はDOMがクリアされ本文が
  // 空になるため、この効果がそのまま下書きの削除も兼ねる。lib/drafts.tsのsetDraftは
  // 空文字を渡すとエントリ自体を消す）。
  useEffect(() => {
    if (!draftKey) return
    const root = editorRef.current
    if (!root) return
    setDraft(draftKey, domToMarkdown(root), mentions)
  }, [draftKey, mentions, contentVersion])

  // 純粋な「見た目・下書き反映の更新」だけを行う（hasUserEditedRefは変更しない）。マウント時の
  // 下書き復元・customEmoji読み込み後の追いかけ変換など、利用者の操作に起因しないDOM変更から呼ぶ。
  // 本文が変わりうる経路（ネイティブ入力・ツールバー操作・メンション/絵文字挿入・貼り付け・
  // 下書き復元・追いかけ変換）がすべてこの関数を通るため、書式のライブプレビュー
  // （ユーザーからの明示的な要望「太字とか下線とかを入力している段階で見られるようにしたい」）の
  // 同期もここ1箇所に集約する。resizeEditor（scrollCaretIntoViewを内包）より前に呼ぶことで、
  // ライブプレビュー適用後の最終的なキャレット位置を基準にスクロール追従が計算されるようにする。
  // skipLiveFormatSync: IME合成中（日本語入力の変換候補選択中）はsyncLiveFormattingが行う
  // Range抽出・DOM再構築を行わない（合成中にDOMを書き換えるとIMEの変換候補ウィンドウが壊れる/
  // キャンセルされるおそれがあるため。handleInput/handleKeyDownの既存のisComposingガードと
  // 同じ考え方）。合成が確定した瞬間（handleCompositionEnd）は必ずスキップなしで呼ばれるため、
  // 書式の反映（記号を隠す・太字等のスタイルを当てる）はIME確定の直後に即座に行われる。
  const refreshEditorHousekeeping = (options?: { skipLiveFormatSync?: boolean }) => {
    const root = editorRef.current
    if (!root) return
    if (!options?.skipLiveFormatSync) {
      syncLiveFormatting(root)
      // IME合成中は更新しない（上のコメント参照）。この関数の末尾で更新することで、
      // materializePendingFormatsが次の呼び出しで比較する基準値が常に「直前の同期後」の
      // 本文文字数になる。
      prevPlainTextLengthRef.current = domToPlainText(root).length
    }
    setHasContent(domToPlainText(root).trim().length > 0)
    setContentVersion((v) => v + 1)
    resizeEditor()
  }

  // pendingFormats（ボタンは押されているがまだ本文に挿入していない書式）を、実際に入力された
  // 文字の周りへ初めて実DOM要素としてラップする（上のpendingFormats宣言のコメント参照。
  // マーカー文字は一切経由しない）。ネイティブ入力・IME確定・貼り付けのいずれの経路でも、
  // 「本文が前回の同期後より何文字増えたか」をprevPlainTextLengthRefとの差分で判定する
  // （Backspace/Delete等の削除系はこの差分が0以下になるため自然に無視される）。増えていなければ
  // 何もしない。増えた分（カーソル直前insertedCount文字）だけをwrapRangeInFormatsで直接
  // ラップし、pendingFormatsをそのままactiveFormatsへ引き継ぐ（既に開いているactiveFormatsが
  // ある場合はその内側に自然に入れ子になる——ラップはプレーンテキストのオフセットだけで
  // 行うため、ネストの深さに関わらずそのまま機能する）。呼び出し元はこの直後に必ず
  // afterMutateを呼ぶこと。
  const materializePendingFormats = (root: HTMLDivElement) => {
    if (pendingFormats.length === 0) return
    const currentLength = domToPlainText(root).length
    const insertedCount = currentLength - prevPlainTextLengthRef.current
    if (insertedCount <= 0) return
    const cursor = getSelectionOffsets(root)?.start
    if (cursor === undefined || cursor < insertedCount) return
    const insertStart = cursor - insertedCount
    wrapRangeInFormats(root, insertStart, cursor, pendingFormats)
    setSelectionOffsets(root, cursor)
    setActiveFormats((prev) => [...prev, ...pendingFormats])
    setPendingFormats([])
  }

  // 書式トグルボタンの押下状態（activeFormats）は、カーソルが現在の書式の終端マーカー列の
  // 直前から外れた時点でボタンの見た目だけを元に戻す（テキストは一切変更しない。詳細は
  // composerEditing.tsのisCursorInsideActiveFormatsのコメント参照）。documentレベルの
  // selectionchangeを監視し、選択範囲がこのエディタ内・かつ折りたたまれている（選択範囲が
  // 無くカーソルのみ）ときだけ判定する。関数型のsetState（prev）を使うことでactiveFormats
  // 自体をこの効果の依存配列に含める必要を無くしている（購読の再登録を避けるため）。
  useEffect(() => {
    const onSelectionChange = () => {
      const root = editorRef.current
      if (!root) return
      const sel = window.getSelection()
      if (!sel || sel.rangeCount === 0) return
      const range = sel.getRangeAt(0)
      if (!range.collapsed) return
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return
      setActiveFormats((prev) => {
        if (prev.length === 0) return prev
        const cursor = getSelectionOffsets(root)?.start
        if (cursor === undefined) return prev
        return isCursorInsideActiveFormats(root, cursor, prev) ? prev : []
      })
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])
  // 利用者の操作（入力・ボタンクリック等）によるDOM変更のあとに呼ぶ。hasUserEditedRefを立てる
  // ことで、customEmoji読み込み待ちの追いかけ変換（上のuseEffect）が、既に本人が編集を始めた
  // 内容を勝手に上書きしないようにする。
  const afterMutate = (options?: { skipLiveFormatSync?: boolean }) => {
    hasUserEditedRef.current = true
    refreshEditorHousekeeping(options)
  }

  const runPostInputChecks = (root: HTMLDivElement) => {
    tryConvertJustCompletedShortcode(root, customEmoji)
    enforceMaxLength(root, MAX_BODY_LENGTH)
    removeStrayEmptyBr(root)
    root.normalize()
    if (mentionCandidates) {
      const cursor = getSelectionOffsets(root)?.start ?? 0
      const match = detectMentionQuery(domToPlainText(root), cursor)
      setPickerQuery(match?.query ?? null)
      setActiveIndex(0)
    }
  }

  // ネイティブ入力（IME・直接タイプ・OSレベルの貼り付け以外の入力全般）を受けるハンドラ。
  // IME合成中（e.nativeEvent.isComposing）は、ショートコード変換・文字数上限の適用・
  // メンション候補の絞り込み・書式のライブプレビュー同期（syncLiveFormatting）を一切行わない
  // （合成中にDOMを書き換えるとIMEの変換候補ウィンドウが壊れる/キャンセルされるおそれがある
  // ため）。合成が確定した瞬間はonCompositionEndで改めて同じチェック（書式同期を含む）を
  // 走らせるため、記号を隠す・太字等のスタイルを当てるといった反映はIME確定の直後に行われる。
  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    const root = editorRef.current
    if (!root) return
    const native = e.nativeEvent as InputEvent
    if (native.inputType === 'historyUndo' || native.inputType === 'historyRedo') {
      normalizeInvariants(root)
    }
    if (!native.isComposing) {
      // 前回のEnterキー処理が置いたCARET_MARKER（composerEditing.ts参照）が残っていれば、
      // 実際に次の文字が入力されたこの時点で速やかに片付ける（domToPlainTextは呼び出しの
      // たびに除外するため安全ではあるが、DOM上に残したままにしない）。
      // バグ修正（ユーザーからの報告「改行してから入力し始めると、IME変換の1文字目だけ確定
      // されてしまう／1文字目が変換確定前に二重入力される」）: 以前はこの呼び出しをhandleInputの
      // 先頭でisComposingに関わらず無条件に行っていた。removeCaretMarkerFromDomは内部で
      // setSelectionOffsets（Selection.removeAllRanges/addRange）を呼ぶため、CARET_MARKERが
      // 残っている状態（＝Enter直後）でIME合成の1文字目を入力すると、合成中にSelectionを
      // 書き換えることになり、ブラウザがIME合成を強制的に確定・中断してしまっていた
      // （実機で「1文字目だけ確定され残りが新しい合成として続く」「1文字目が二重に入力される」
      // という形で顕在化）。合成中は呼ばず、合成確定時（handleCompositionEnd）に改めて呼ぶ。
      removeCaretMarkerFromDom(root)
      // IME合成中はmaterializePendingFormatsを呼ばない（合成中のDOM書き換えを避ける、
      // 上のコメントと同じ理由。合成確定時にはhandleCompositionEndで改めて呼ぶ）
      materializePendingFormats(root)
      runPostInputChecks(root)
    }
    afterMutate(native.isComposing ? { skipLiveFormatSync: true } : undefined)
  }

  const handleCompositionEnd = () => {
    const root = editorRef.current
    if (!root) return
    removeCaretMarkerFromDom(root)
    materializePendingFormats(root)
    runPostInputChecks(root)
    afterMutate()
  }

  const toggleSchedulePopover = () => {
    if (!scheduleOpen) {
      const d = defaultScheduleDateTime()
      setScheduleDate((prev) => prev || d.date)
      setScheduleTime((prev) => prev || d.time)
      setPickerQuery(null)
      setEmojiOpen(false)
      setLinkOpen(false)
    }
    setScheduleOpen((v) => !v)
  }

  // 絵文字入力（ユーザーからの明示的な要望「Slackのように絵文字入力ボタンをメンションの横に
  // つけたい」）。カスタム絵文字（`:name:`ショートコードでcustomEmojiに解決できるもの）は
  // その場で原子img要素として挿入し、それ以外（Unicode絵文字）はプレーンテキストとして挿入する。
  const insertEmoji = (emoji: string) => {
    const root = editorRef.current
    if (!root) return
    const shortcodeMatch = /^:([a-zA-Z0-9_+-]{2,24}):$/.exec(emoji)
    const resolved = shortcodeMatch
      ? customEmoji.find((e) => e.name.toLowerCase() === shortcodeMatch[1].toLowerCase())
      : undefined
    if (resolved) {
      insertAtomicEmojiAtCursor(root, resolved.name, resolved.image_url)
    } else {
      const offs = getSelectionOffsets(root)
      const total = domToPlainText(root).length
      const start = offs?.start ?? total
      const end = offs?.end ?? start
      replaceRangeWithText(root, start, end, emoji)
    }
    // バグ修正: 太字等をボタンで開いた（pendingFormats、まだ何も入力していない）直後に
    // 絵文字ピッカーから挿入すると、この呼び出しが無いとpendingFormatsが消費されずボタンが
    // 押されたまま取り残されてしまっていた（handlePasteは既にこの呼び出しを持っていたが、
    // insertEmojiには無かった抜け漏れ）。
    materializePendingFormats(root)
    setEmojiOpen(false)
    afterMutate()
  }

  // 本文から削除されたメンションは除外する（選択後にテキストを手で消した場合の整合性維持。
  // 即時送信・送信予約のいずれも同じ基準で絞り込む）
  const activeMentionsIn = (text: string) => mentions.filter((m) => text.includes(`@${m.display_name_snapshot}`))

  // F-07 ファイル添付（A-21）。アップロード自体はここで即座に行い、返ってきたfile_name/byte_size/
  // storage_pathを保持しておいて、実際の送信（A-11/A-14/A-19）でattachmentsとして渡す
  // （F-41のメンションと同じ「先に確定させ、参照だけ送信時に渡す」パターン）
  const pickFile = async (file: File | null) => {
    if (!file) return
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast('ファイルサイズは20MBまでです', 'error')
      return
    }
    setUploading(true)
    try {
      const uploaded = await uploadAttachment(file)
      setAttachments((prev) => [...prev, uploaded])
    } catch (e) {
      toast(e instanceof Error ? e.message : 'アップロードに失敗しました', 'error')
    } finally {
      setUploading(false)
    }
  }
  const removeAttachment = (index: number) => setAttachments((prev) => prev.filter((_, i) => i !== index))

  const clearEditor = () => {
    const root = editorRef.current
    if (!root) return
    root.replaceChildren()
    setActiveFormats([])
    setPendingFormats([])
    afterMutate()
  }

  const confirmSchedule = async () => {
    const root = editorRef.current
    const text = (root ? closeDanglingCodeFence(domToMarkdown(root)) : '').trim()
    if (!text) {
      toast('本文を入力してください', 'error')
      return
    }
    if (attachments.length > 0) {
      // F-35: 予約送信ではファイル添付は利用できない（基本設計書6.2節「設計判断」）
      toast('送信予約ではファイルを添付できません。添付を外してください', 'error')
      return
    }
    if (!scheduleDate || !scheduleTime) {
      toast('送信日時を指定してください', 'error')
      return
    }
    const scheduledAt = new Date(`${scheduleDate}T${scheduleTime}:00`)
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
      toast('未来の日時を指定してください', 'error')
      return
    }
    setScheduling(true)
    try {
      await apiFetch('/api/scheduled-messages', {
        method: 'POST',
        body: JSON.stringify({
          ...scheduleTarget,
          body: text,
          mentions: activeMentionsIn(text),
          scheduled_at: scheduledAt.toISOString(),
        }),
      })
      clearEditor()
      setMentions([])
      setScheduleOpen(false)
      toast('送信を予約しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '予約に失敗しました', 'error')
    } finally {
      setScheduling(false)
    }
  }

  // 書式ツールバー（コード・箇条書き・引用等）。ユーザーからの明示的な要望「Slackのメッセージ
  // 入力欄と同じように、コードのボックス・下線・ボールド・箇条書きのような機能を付けたい」による
  // 追加。すべてのボタンはonMouseDown+preventDefaultでフォーカス（＝contentEditableの選択範囲）を
  // 失わせない（既存のメンション/絵文字ピッカーと同じパターンを全ボタンへ広げた。2026-09-18の
  // contentEditable化に伴う変更——textareaのselectionStartはフォーカスを失っても値を保持するが、
  // contentEditableのSelectionはフォーカスを失うと容易に失われるため、そもそもフォーカスを
  // 離さない設計にした）。

  // 書式トグルボタン（太字・斜体・下線・取り消し線）。ユーザーからの明示的な要望「入力している
  // 段階で送信した後の表示と同じようにしたい。記号で囲むような表示をなくしたい。太字、斜体、
  // 下線、取り消し線に関しては、ボタンが押されている間はその記法になり、もう一度ボタンを押すと
  // 解除される、というような仕組みにしてほしい（Wordみたいな感じ）」。選択範囲がある場合は
  // 従来どおり「選択範囲を囲む/既に囲まれていれば外す」トグル（選択済みの実テキストが対象のため、
  // pendingFormatsという「未確定」の概念は関係ない）。
  //
  // 選択範囲が無い場合: ユーザーからの追加報告「記法のボタン押すと一文字分見えない何かが
  // 入力されるのやめてほしい」を受け、まだ本文に無い書式をこれから有効化する場合は本文へ
  // 一切触れず、pendingFormats（上記宣言のコメント参照）の切り替えだけで済ませる。既に
  // activeFormats（＝実際にDOM構造として本文にある）に含まれる書式を解除する場合のみ、
  // composerEditing.tsのtoggleFormatAtCursorDomを呼ぶ。
  const toggleFormatButton = (kind: ToggleFormatKind) => {
    const root = editorRef.current
    if (!root) return
    const offs = getSelectionOffsets(root)
    const total = domToPlainText(root).length
    const start = offs?.start ?? total
    const end = offs?.end ?? start
    if (start !== end) {
      const result = toggleFormatOnSelectionDom(root, start, end, kind)
      setSelectionOffsets(root, result.selectionStart, result.selectionEnd)
      setPendingFormats([])
      setPickerQuery(null)
      afterMutate()
      return
    }
    if (!activeFormats.includes(kind)) {
      // まだ本文に無い書式のトグル: DOMには一切触れず、次に入力される文字へ適用する保留
      // 状態だけを切り替える（既にpendingならもう一度押して解除、まだなら追加）。
      // コードは他のトグル書式と組み合わせ不可能（composerEditing.tsのToggleFormatKindコメント
      // 参照。MessageList.tsx側の重なり解決でコードが常に太字等より優先され、太字側が丸ごと
      // 棄却されてしまうため）。armする際は相手側を全て置き換える。
      if (kind === 'code') {
        setPendingFormats((prev) => (prev.includes('code') ? [] : ['code']))
      } else if (pendingFormats.includes('code')) {
        setPendingFormats([kind])
      } else {
        setPendingFormats((prev) => (prev.includes(kind) ? prev.filter((f) => f !== kind) : [...prev, kind]))
      }
      setPickerQuery(null)
      return
    }
    const result = toggleFormatAtCursorDom(root, start, activeFormats, kind)
    setActiveFormats(result.activeFormats)
    if (result.newlyPending.length > 0) {
      setPendingFormats((prev) => Array.from(new Set([...prev, ...result.newlyPending])))
    }
    setPickerQuery(null)
    afterMutate()
  }

  // コードボタンは選択範囲に改行を含むかで自動的にインラインコード/コードブロックを切り替える
  // （GitHubのコメント欄と同じ挙動。ボタンを1つに減らせるうえ直感的なため）。2026-09-25、
  // インラインコード・コードブロックともマーカー文字を持たない実DOM構造になったため、改行を
  // 含まない場合はtoggleFormatButton('code')（トグル書式）へ、含む場合はwrapRangeAsCodeBlock
  // （<pre>で直接ラップ、マーカー文字を一切経由しない）へ委譲する。
  const wrapCode = () => {
    const root = editorRef.current
    if (!root) return
    const offs = getSelectionOffsets(root)
    const selectedText = offs ? domToPlainText(root).slice(offs.start, offs.end) : ''
    if (offs && selectedText.includes('\n')) {
      wrapRangeAsCodeBlock(root, offs.start, offs.end)
      setSelectionOffsets(root, offs.start, offs.end)
      setPickerQuery(null)
      afterMutate()
    } else {
      toggleFormatButton('code')
    }
  }

  // リンク（ユーザーからの明示的な要望「リンクを張れるようになると嬉しい」）。記法は他の書式
  // （`**太字**`等）と同じGFM風の`[表示文字](URL)`を採用（Slack自体の`<url|text>`記法は
  // 他の書式と同様に独自すぎるため避けた）。ユーザーからの明示的な要望「スラックみたいに、
  // リンクもボタンを押したら、テキストとリンクを設定する画面ポップアップが出てきてほしい」を
  // 受け、テキスト・URLをそれぞれ入力するポップアップ方式にしている。
  const toggleLinkPopover = () => {
    if (!linkOpen) {
      const root = editorRef.current
      const offs = root ? getSelectionOffsets(root) : null
      const total = root ? domToPlainText(root).length : 0
      const start = offs?.start ?? total
      const end = offs?.end ?? start
      linkSelectionRef.current = { start, end }
      setLinkText(root ? domToPlainText(root).slice(start, end) : '')
      setLinkUrl('')
      setPickerQuery(null)
      setEmojiOpen(false)
      setScheduleOpen(false)
    }
    setLinkOpen((v) => !v)
  }

  const LINK_URL_RE = /^https?:\/\/\S+$/
  const confirmLink = () => {
    const url = linkUrl.trim()
    if (!LINK_URL_RE.test(url)) {
      toast('URLはhttps://から始まる形式で入力してください', 'error')
      return
    }
    // テキスト未入力時はURL自体を表示文字にする（Slackも同様に、テキストを指定しなければURLが
    // そのまま表示される）
    const text = linkText.trim() || url
    const root = editorRef.current
    if (!root) return
    const { start, end } = linkSelectionRef.current
    replaceRangeWithText(root, start, end, `[${text}](${url})`)
    setLinkOpen(false)
    afterMutate()
  }

  // 選択中の文字列の上にURLを貼り付けると、その文字列をリンクの表示テキストにしたリンクへ変換する
  // （ユーザーからの明示的な要望「欲を言うとslackみたいに文字指定してリンクを張り付けるとリンクが
  // 格納されるととてもうれしい」）。それ以外の貼り付けはプレーンテキストとして挿入する
  // （2026-09-18のcontentEditable化に伴い、あらゆる貼り付けを自前化した。ブラウザ既定のリッチ
  // 貼り付けに任せると、Wordや任意のWebページからのコピーで想定外のブロック要素・スタイル・
  // 偽の<img>が紛れ込み、原子絵文字img（data-emoji-name属性で判別）との区別がつかなくなり、
  // 以後のオフセットベース処理全体が壊れるため、常にpreventDefaultしてプレーンテキストのみ
  // 手動挿入する）。
  const LINK_PASTE_URL_RE = /^https?:\/\/\S+$/
  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const root = editorRef.current
    if (!root) return
    const offs = getSelectionOffsets(root)
    const total = domToPlainText(root).length
    const start = offs?.start ?? total
    const end = offs?.end ?? start
    const pasted = e.clipboardData.getData('text/plain')
    const trimmed = pasted.trim()
    if (start !== end && LINK_PASTE_URL_RE.test(trimmed)) {
      const selectedText = domToPlainText(root).slice(start, end)
      replaceRangeWithText(root, start, end, `[${selectedText}](${trimmed})`)
    } else {
      replaceRangeWithText(root, start, end, pasted)
    }
    // 旧実装（textarea）はブラウザ既定の貼り付けが自動的にmaxLength属性で切り詰めてくれていたが、
    // 貼り付けを全面的に自前化した（全ての貼り付けをpreventDefaultしプレーンテキストのみ手動挿入
    // する設計、上のコメント参照）ことでこの自動切り詰めが失われた。paste特有の欠落のため、ここで
    // 明示的に補う（書式ボタン等での数文字程度の超過は旧実装でも元々防げていなかったため対象外）。
    enforceMaxLength(root, MAX_BODY_LENGTH)
    materializePendingFormats(root)
    afterMutate()
  }

  // 箇条書きボタン。2026-09-25、箇条書きがマーカー文字を持たない実DOM構造
  // （1行=1つのdata-block-format="list-item"要素、composerEditing.ts参照）になったため、
  // insertQuoteと同じ考え方で「外す」方向はgetBlockFormatAtでカーソルが既存のリストの内側かを
  // 直接見て判定する（内側ならリストごと解除）。「付ける」方向は選択範囲を含む行全体を
  // convertLinesToListItemsで構築する。何も入力されていない行にカーソルがある状態でボタンを
  // 押した場合も1つの空項目を作る（ユーザーからの要望「何も入力されていない行で箇条書き
  // ボタンを押しても箇条書きのマークが出てくるようにしたい」、convertLinesToListItems側で
  // start===endを許容している）。
  const insertBulletList = () => {
    const root = editorRef.current
    if (!root) return
    const offs = getSelectionOffsets(root)
    const total = domToPlainText(root).length
    const start = offs?.start ?? total
    const end = offs?.end ?? start

    const blockAtCursor = getBlockFormatAt(root, start)
    if (blockAtCursor?.kind === 'list' || blockAtCursor?.kind === 'list-item') {
      const listEl = blockAtCursor.kind === 'list' ? blockAtCursor.el : (blockAtCursor.el.parentElement as HTMLElement)
      ungroupListElement(listEl)
      setPickerQuery(null)
      afterMutate()
      return
    }

    const text = domToPlainText(root)
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    const nextNewline = text.indexOf('\n', end)
    const lineEnd = nextNewline === -1 ? text.length : nextNewline
    convertLinesToListItems(root, lineStart, lineEnd)
    // バグ修正（ユーザーからの報告「箇条書きの記法ができなくなっている」）: convertLinesToListItems
    // はrange.extractContents/insertNodeでDOMを組み替えるだけでSelectionには一切触れないため、
    // 呼び出し元がここで明示的に置き直さないと、元のSelectionが道連れで無効化され、続けて
    // 入力した文字がリストの外に入ってしまっていた（空行のケースはconvertLinesToListItems内の
    // CARET_MARKER処理に任せる——start===endではボタン押下前後でオフセットが変わらないため、
    // ここでも一応setSelectionOffsetsするが空要素内では効かず、内部のCARET_MARKER配置が優先される）。
    // start<endの非空行は、この経路がマーカー文字を経由しないため変換前後で文字数が変わらず、
    // start/endの数値をそのまま使い回せる。
    if (lineStart !== lineEnd) setSelectionOffsets(root, start, end)
    setPickerQuery(null)
    afterMutate()
  }

  // 引用ボタン（ユーザーからの明示的な要望「Slackと同じような引用タグの機能を付けたい」）。
  // 2026-09-25、引用がマーカー文字を持たない実DOM構造（<blockquote data-block-format="quote">）に
  // なったため、「外す」方向はテキストの「> 」プレフィックス判定（変換後は既に存在しない）ではなく
  // getBlockFormatAtでカーソルが既存の<blockquote>の内側かどうかを直接見て判定する。内側なら
  // ブロックごと解除（unwrapするだけ——外側の"\n"境界には触れないため前後の行は影響を受けない）。
  // 「付ける」方向は従来どおり行頭に「> 」をテキストとして挿入し、直後のsyncLiveFormattingの
  // 自動検出（手打ちと同じ経路）に変換を任せる。
  const insertQuote = () => {
    const root = editorRef.current
    if (!root) return
    const offs = getSelectionOffsets(root)
    const total = domToPlainText(root).length
    const start = offs?.start ?? total
    const end = offs?.end ?? start

    const blockAtCursor = getBlockFormatAt(root, start)
    if (blockAtCursor?.kind === 'quote') {
      const el = blockAtCursor.el
      const parent = el.parentNode
      if (parent) {
        while (el.firstChild) parent.insertBefore(el.firstChild, el)
        parent.removeChild(el)
        root.normalize()
      }
      setPickerQuery(null)
      afterMutate()
      return
    }

    const text = domToPlainText(root)
    const lineStart = text.lastIndexOf('\n', start - 1) + 1
    const nextNewline = text.indexOf('\n', end)
    const lineEnd = nextNewline === -1 ? text.length : nextNewline
    const lines = text.slice(lineStart, lineEnd).split('\n')
    const nextLines = lines.map((l) => {
      if (l.trim() === '') return lines.length === 1 ? '> ' : l
      return l.startsWith('> ') ? l : `> ${l}`
    })
    const nextBlock = nextLines.join('\n')
    replaceRangeWithText(root, lineStart, lineEnd, nextBlock)
    setPickerQuery(null)
    afterMutate()
  }

  // メンション候補の選択（人間・@channel・@here・チャンネルAIすべて共通）。ハイライトは
  // 挿入時点のみ付与する（詳細はcomposerEditing.tsの冒頭コメント参照）。挿入した表示文字列
  // 直後の空白は意図的にハイライトspanの外側（別のプレーンテキストノード）として挿入し、
  // 利用者がメンションの直後から手打ちを続けたときに新しい文字が誤ってspanへ吸い込まれ
  // ハイライトが不自然に広がってしまう可能性を減らす（Planサブエージェントの精査で指摘された
  // 境界問題への緩和。完全な防止ではなく既知の表示上の制約として許容する）。
  const selectCandidate = (candidate: MentionCandidate) => {
    const root = editorRef.current
    if (!root) return
    const cursor = getSelectionOffsets(root)?.start ?? domToPlainText(root).length
    const match = detectMentionQuery(domToPlainText(root), cursor)
    if (!match) return
    const displayText = `@${candidate.name}`
    const { span } = replaceRangeWithMentionSpan(root, match.atIndex, cursor, displayText)
    // span要素そのものへの参照を使い、DOM操作でspanの兄弟として明示的に外側へ空白を挿入する
    // （オフセットベースの挿入だとspanの中に吸い込まれてしまう、詳細はcomposerEditing.tsの
    // insertTextAfterNodeのコメント参照）。カーソル位置もこの関数が直接設定する。
    insertTextAfterNode(span, ' ')
    if (candidate.isChannel) {
      // @channel はkind='channel'として送る（target_user_idは使わない）。重複選択しても1件だけ持つ
      setMentions((prev) =>
        prev.some((m) => m.kind === 'channel')
          ? prev
          : [...prev, { target_user_id: 'channel', display_name_snapshot: candidate.name, kind: 'channel' }],
      )
    } else if (candidate.isHere) {
      // @here はkind='here'として送る（対象者の特定はバックエンドが送信時点で行う）。重複選択も1件だけ
      setMentions((prev) =>
        prev.some((m) => m.kind === 'here')
          ? prev
          : [...prev, { target_user_id: 'here', display_name_snapshot: candidate.name, kind: 'here' }],
      )
    } else if (!candidate.isAi) {
      setMentions((prev) => [...prev, { target_user_id: candidate.id, display_name_snapshot: candidate.name }])
    }
    setPickerQuery(null)
    afterMutate()
  }

  // 入力欄下のメンションボタン（画面モックアップS-03のmention-btn）。カーソル位置に「@」を挿入し
  // ピッカーを開く。直前の文字が空白でない場合はdetectMentionQueryの開始条件を満たすよう半角空白を補う。
  const insertMentionTrigger = () => {
    const root = editorRef.current
    if (!root) return
    const cursor = getSelectionOffsets(root)?.start ?? domToPlainText(root).length
    const text = domToPlainText(root)
    const before = text[cursor - 1]
    const insertText = cursor === 0 || before === undefined || /\s/.test(before) ? '@' : ' @'
    replaceRangeWithText(root, cursor, cursor, insertText)
    setPickerQuery('')
    setActiveIndex(0)
    setScheduleOpen(false)
    setEmojiOpen(false)
    setLinkOpen(false)
    afterMutate()
  }

  // 絵文字ピッカーの開閉。ボタン自体はonMouseDown+preventDefaultでフォーカスを失わせないため、
  // 旧実装にあったrequestAnimationFrameでの再フォーカスは不要になった。
  const toggleEmojiPopover = () => {
    if (!emojiOpen) {
      setPickerQuery(null)
      setScheduleOpen(false)
      setLinkOpen(false)
    }
    setEmojiOpen((v) => !v)
  }

  // ユーザーからの明示的な要望「絵文字ピッカーを開いた状態で、ピッカー外の部分をクリックすると
  // 閉じるようにしてほしい」。MessageList.tsxのEmojiGridPopoverと同じ「document全体のmousedownを
  // 監視し、ピッカー自身のref外へのクリックなら閉じる」パターンを踏襲する（開いている間だけ
  // リスナーを登録し、それ以外は登録しない）。絵文字追加モーダル（document.bodyへの別ポータル、
  // ピッカーのref外）を開いている間はこのモーダル内クリックを誤って「外側」と判定しないよう除外する。
  //
  // 実機Playwright検証で、開いた直後に自分自身が即座に閉じてしまう不具合を発見した。原因は
  // トグルボタン自体がonMouseDown（contentEditableのフォーカスを失わせないため）で開いており、
  // このポップオーバーを開いた瞬間の再レンダー・エフェクト実行が、EmojiGridPopover（トグルが
  // onClickのため無関係）と異なり、まだ完全にバブリングし終えていない「同一のmousedown」の
  // 続きの中で（Reactの同期的なdiscrete更新フラッシュにより）行われてしまうこと——ここで
  // documentへリスナーを登録すると、登録した時点でまだdocumentに到達していない進行中の同じ
  // イベントの続きを自分自身が受け取ってしまい、「ボタンの外側（=ボタン自身は絵文字ピッカー
  // divの外）がクリックされた」と誤判定して即座に閉じていた。setTimeout(0)でリスナー登録を
  // 次のタスクへ遅延させ、開くきっかけとなったmousedownイベント自体の完全な完了後に初めて
  // 有効化することで解消した。
  useEffect(() => {
    if (!emojiOpen) return
    const onDocMouseDown = (e: MouseEvent) => {
      if (showAddEmojiModal) return
      if (emojiPopoverRef.current && !emojiPopoverRef.current.contains(e.target as Node)) {
        setEmojiOpen(false)
      }
    }
    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', onDocMouseDown)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('mousedown', onDocMouseDown)
    }
  }, [emojiOpen, showAddEmojiModal])

  // バグ調査（ユーザーからの報告「たまにAIが二回応答するときがある」）: 本番DBを実際に調査した結果、
  // AI側の重複ではなく、同一の人間の発言そのものが数百ミリ秒の間に最大6回連続で投稿されており、
  // それぞれが独立してAI応答を起動していたことが判明した（各AI応答は互いに独立した正常な処理で、
  // 「原因」の発言が複数あっただけ）。原因はCtrl+Enter送信のkeydownハンドラ（下記handleKeyDown）に
  // 連打・キーリピートへのガードが無かったこと——送信ボタン側は`disabled={sending}`で二重クリックを
  // 防いでいたが、キーボード経由の送信にはこの保護が一切掛かっていなかった。sendingRef（useRef）で
  // 同期的な再入防止を行う（sending stateはReactのバッチ更新の都合上、同一tick内の連続呼び出しでは
  // 更新前の古い値を見てしまう可能性があるため、refで即座に一貫した値を参照できるようにする）
  const send = async () => {
    if (sendingRef.current) return
    const root = editorRef.current
    if (!root) return
    const text = closeDanglingCodeFence(domToMarkdown(root)).trim()
    if (!text) return
    sendingRef.current = true
    setSending(true)
    try {
      await onSend(text, activeMentionsIn(text), attachments)
      clearEditor()
      setMentions([])
      setAttachments([])
    } catch (e) {
      toast(e instanceof Error ? e.message : '送信に失敗しました', 'error')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  // バグ修正（実機Playwright検証で発見）: 原子絵文字img（contenteditable="false"）へ直接
  // クリックしても、通常のテキストクリックと異なりChromiumがネイティブにキャレットを
  // 再配置しない（クリック前のカーソル位置がそのまま残ってしまう）ことを実機で確認した。
  // 一方、同じ座標を`document.caretRangeFromPoint`へ直接問い合わせると正しい境界位置
  // （画像の手前/直後）を返すことも確認できたため、原子ノードへのクリックだけを対象に、
  // このAPIで明示的にキャレット位置を計算し直す（通常のテキスト上のクリック・ドラッグ選択は
  // ブラウザのネイティブ処理のまま変更しない——これらは既に正しく動作しているため、全クリックを
  // 一律に上書きすると複数文字のドラッグ選択等を壊してしまう）。
  const handleEditorClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.tagName !== 'IMG' || !target.hasAttribute('data-emoji-name')) return
    const doc = target.ownerDocument as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
    }
    if (!doc.caretRangeFromPoint) return
    const range = doc.caretRangeFromPoint(e.clientX, e.clientY)
    if (!range) return
    const sel = window.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(range)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // IME（日本語入力）の変換候補確定中に送信・改行・箇条書き継続・メンション候補選択と
    // 誤って解釈しないための最重要ガード。変換確定のEnterキー等はここで一切処理せず、
    // ブラウザのネイティブなIME処理にそのまま委ねる（Planサブエージェントの設計精査で
    // 指摘された、この種の実装で最も起きやすい不具合クラスへの対処）。
    if ((e.nativeEvent as KeyboardEvent).isComposing) return

    if (emojiOpen && e.key === 'Escape') {
      setEmojiOpen(false)
      return
    }
    if (pickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % filteredCandidates.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + filteredCandidates.length) % filteredCandidates.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectCandidate(filteredCandidates[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        setPickerQuery(null)
        return
      }
    }
    // 箇条書きの項目先頭（絶対オフセットがちょうど項目の開始位置と一致する場合）でのBackspaceは
    // 自前で処理する。項目またぎのブロック要素の結合はブラウザ間の挙動が大きく異なるため
    // （Enterキー処理と同じ理由、ファイル冒頭の設計判断コメント参照）。それ以外のBackspace
    // （項目の途中・項目が無い等）は一切介入せず、今まで通りネイティブ処理に任せる。
    if (e.key === 'Backspace') {
      const root = editorRef.current
      const offs = root ? getSelectionOffsets(root) : null
      if (root && offs && offs.start === offs.end) {
        const block = getBlockFormatAt(root, offs.start)
        if (block?.kind === 'list-item' && offs.start === computeElementOffset(root, block.el).start) {
          e.preventDefault()
          handleBackspaceAtListItemStart(root, block.el)
          afterMutate()
          return
        }
      }
    }
    // Enterキー＝改行・Ctrl+Enter（Macは⌘+Enter）＝送信（Slackと同じ挙動。ユーザーからの明示的な
    // 要望による変更、従来はEnter単体で即送信・Shift+Enterで改行だった）。
    // バグ修正（ユーザーからの報告「たまにAIが二回応答するときがある」、実機データで原因を特定
    // ——詳細はsend()直前のコメント参照）: e.repeatはOSのキーリピート（キーを押しっぱなしにした
    // 際に発火し続けるkeydown）のときtrueになる。Ctrl+Enterを押しっぱなしにすると本来の1回の
    // 送信意図に対してこのハンドラが何度も呼ばれてしまうため、repeat中は無視する（実際の二重送信
    // 防止自体はsend()内のsendingRefが担うが、そもそも無駄な呼び出し自体を減らす）
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      if (e.repeat) return
      send()
      return
    }
    // contentEditableではEnterキーの既定挙動（ブロック要素の分割等、ブラウザ間で挙動が
    // 大きく異なる）に任せず、常に自前で処理する（改行はテキストノード内の生の"\n"文字として
    // 挿入し、white-space:pre-wrapで見た目を成立させる。詳細はcomposerEditing.tsの
    // 冒頭コメント参照）。選択範囲がある場合（＝Enterで選択部分を置き換える通常の入力）は
    // 対象外とし、素朴にカーソル位置のみのケースに絞る。
    //
    // 箇条書き・引用（2026-09-25、共にマーカー文字を持たない実DOM構造へ書き換え）は
    // getBlockFormatAtでカーソルがlist-item/<blockquote>の内側かどうかを判定する。箇条書きは
    // handleEnterInListItem（composerEditing.ts）に委譲——項目が空ならリストを抜け、空でなければ
    // カーソル以降を新しい項目として切り出す。引用は<blockquote>の内側に生の"\n"を1文字
    // 挿入するだけで続き行になる（マーカー文字を挿入する必要が無い分、以前よりむしろ単純に
    // なった）。空行での脱出は、その空行（内部の末尾の"\n"）を<blockquote>から取り除き、
    // insertTextAfterNodeで<blockquote>の外側（直後）へ新しいプレーンな行を作る——数値
    // オフセットのsetSelectionOffsetsだけに頼ると、resolveOffsetが「その位置より後に何も
    // 実体が無い」場合に要素の内側に留まる位置を返してしまう既知のバイアス
    // （composerEditing.tsのtoggleFormatAtCursorDomのコメント参照）により、外に出したはずの
    // カーソルが<blockquote>の内側へ巻き戻ってしまうため。
    if (e.key === 'Enter') {
      e.preventDefault()
      const root = editorRef.current
      if (!root) return
      const offs = getSelectionOffsets(root)
      if (offs && offs.start === offs.end && !e.shiftKey) {
        const cursor = offs.start
        const block = getBlockFormatAt(root, cursor)
        if (block?.kind === 'list-item') {
          handleEnterInListItem(root, block.el, cursor)
          afterMutate()
          return
        }
        if (block?.kind === 'quote') {
          const text = domToPlainText(root)
          const lineStart = text.lastIndexOf('\n', cursor - 1) + 1
          const nextNewlineIdx = text.indexOf('\n', cursor)
          const lineEnd = nextNewlineIdx === -1 ? text.length : nextNewlineIdx
          const currentLine = text.slice(lineStart, lineEnd)
          if (currentLine.trim() === '') {
            replaceRangeWithText(root, lineStart - 1, lineStart, '')
            insertTextAfterNode(block.el, '\n')
            const pos = getSelectionOffsets(root)?.start ?? domToPlainText(root).length
            ensureTrailingNewlineCaretMarker(root)
            setSelectionOffsets(root, pos)
          } else {
            const pos = replaceRangeWithText(root, cursor, cursor, '\n')
            ensureTrailingNewlineCaretMarker(root)
            setSelectionOffsets(root, pos)
          }
          afterMutate()
          return
        }
        // バグ修正（ユーザーからの報告「コード表記で入力しているときに、途中でEnterを押して
        // 改行してから（2行以上にしてから）送信すると、チャンネル会話上でコード表示ではなく
        // なってしまう」）: インラインコード（`` ` ``、TOGGLE_FORMAT_ELEMENT_ATTR="code"）は
        // list-item/quoteと違いgetBlockFormatAtの対象外（BLOCK_FORMAT_ATTRではない）のため、
        // 何もしなければ下のジェネリックな分岐がそのままインラインコード要素の中へ生の"\n"を
        // 挿入してしまっていた。送信Markdownは改行入りの`` `...\n...` ``になり、コードブロック
        // （```の対）にもインラインコード（改行を含められない単一`` ` ``、MessageList.tsxの
        // INLINE_CODE_REGEX参照）にも一致せず、生の記号付きプレーンテキストとして表示されて
        // いた。wrapCode（選択範囲に改行を含む場合の自動切り替え）と同じ考え方で、カーソルが
        // インラインコードの内側にいる状態でEnterが押されたらコードブロックへ自動アップグレード
        // する。
        const inlineCode = getInlineCodeElementAt(root, cursor)
        if (inlineCode) {
          const codeRange = computeElementOffset(root, inlineCode)
          const parent = inlineCode.parentNode
          if (parent) {
            while (inlineCode.firstChild) parent.insertBefore(inlineCode.firstChild, inlineCode)
            parent.removeChild(inlineCode)
            root.normalize()
          }
          setActiveFormats((prev) => prev.filter((f) => f !== 'code'))
          const pos = replaceRangeWithText(root, cursor, cursor, '\n')
          wrapRangeAsCodeBlock(root, codeRange.start, codeRange.end + 1)
          ensureTrailingNewlineCaretMarker(root)
          setSelectionOffsets(root, pos)
          afterMutate()
          return
        }
      }
      if (offs) {
        const pos = replaceRangeWithText(root, offs.start, offs.end, '\n')
        // バグ修正（ユーザーからの報告、composerEditing.tsのensureTrailingNewlineCaretMarker
        // コメント参照）: この\nが今まさに本文の末尾になった場合、ブラウザがその直後の
        // キャレット位置を正しく計測できず、次に入力した文字が新しい行ではなく直前の行の
        // 末尾に挿入されてしまう不具合があった。挿入直後にマーカーを置き直し、カーソル位置も
        // 明示的に再設定する（replaceRangeWithText自身も内部でカーソルを設定するが、直後の
        // DOM変更でその設定が古くなるため、確定した本文オフセットposを使って再設定する）
        ensureTrailingNewlineCaretMarker(root)
        setSelectionOffsets(root, pos)
      }
      afterMutate()
    }
  }

  // コードは他のトグル書式と組み合わせ不可能（toggleFormatButtonのコメント参照）なため、
  // 片方がpending/active中はもう片方のボタンをUI上も押せなくする
  const codeFormatActive = activeFormats.includes('code') || pendingFormats.includes('code')
  const otherFormatActive = activeFormats.some((f) => f !== 'code') || pendingFormats.some((f) => f !== 'code')

  return (
    <div className="relative rounded-[10px] border border-line-strong px-3 py-2.5">
      {pickerOpen && (
        <div className="absolute bottom-full left-0 z-40 mb-2 max-h-[260px] w-[300px] overflow-y-auto rounded-xl border border-line-strong bg-surface p-1.5 shadow-[0_12px_30px_rgba(16,24,40,0.18)]">
          {filteredCandidates.map((c, i) => (
            <button
              key={c.id}
              ref={i === activeIndex ? activeCandidateRef : undefined}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                selectCandidate(c)
              }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left ${
                i === activeIndex ? 'bg-accent-200' : 'hover:bg-surface-subtle'
              }`}
            >
              {c.picture_url ? (
                <img
                  src={c.picture_url}
                  alt=""
                  referrerPolicy="no-referrer"
                  className={`h-7 w-7 flex-none object-cover ${c.isAi ? 'rounded-[8px]' : 'rounded-full'}`}
                />
              ) : c.isAi ? (
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[8px] bg-gradient-to-br from-accent-600 to-accent-700 text-[10px] font-bold text-white">
                  AI
                </span>
              ) : c.isChannel ? (
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[8px] bg-danger-text text-[13px] font-bold text-white">
                  @
                </span>
              ) : c.isHere ? (
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-[8px] bg-ok-text text-[13px] font-bold text-white">
                  @
                </span>
              ) : (
                <span
                  className="flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-bold text-white"
                  style={{ background: avatarColorFor(c.id) }}
                >
                  {c.name.slice(0, 1)}
                </span>
              )}
              <span className="truncate text-[12.5px] font-bold text-ink">{c.name}</span>
              {c.isChannel && (
                <span className="ml-auto flex-none text-[11px] text-ink-subtle">チャンネル全員に通知</span>
              )}
              {c.isHere && (
                <span className="ml-auto flex-none text-[11px] text-ink-subtle">今アクティブな人に通知</span>
              )}
            </button>
          ))}
        </div>
      )}
      {emojiOpen && (
        <div
          ref={emojiPopoverRef}
          className="absolute bottom-full left-0 z-40 mb-2 grid max-h-[280px] w-[314px] grid-cols-8 gap-0.5 overflow-y-auto rounded-xl border border-line-strong bg-surface p-1.5 shadow-[0_12px_30px_rgba(16,24,40,0.18)]">
          {/* 既存（Unicode）の絵文字とカスタム絵文字を見出しで分けて表示する（ユーザーからの
              明示的な要望「既存の絵文字と、新しく作った絵文字を分けて表示させたい」）。col-span-8の
              見出し行を挟むと、8列グリッドの自動配置により後続タイルが自然に次の行から始まる */}
          <div className="col-span-8 px-1 pt-0.5 text-[10.5px] font-semibold text-ink-subtle">絵文字</div>
          {EMOJI_LIST.map((emoji, i) => (
            <button
              key={`${emoji}-${i}`}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                insertEmoji(emoji)
              }}
              className="flex h-9 w-9 items-center justify-center rounded-md text-[20px] hover:bg-surface-muted"
            >
              {emoji}
            </button>
          ))}
          <div className="col-span-8 mt-1 border-t border-line px-1 pt-1.5 text-[10.5px] font-semibold text-ink-subtle">
            カスタム絵文字
          </div>
          {customEmoji.map((e) => (
            <button
              key={e.id}
              type="button"
              title={`:${e.name}:`}
              onMouseDown={(ev) => {
                ev.preventDefault()
                insertEmoji(`:${e.name}:`)
              }}
              className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-surface-muted"
            >
              <img src={e.image_url} alt={e.name} className="h-7 w-7 object-contain" />
            </button>
          ))}
          <button
            type="button"
            title="絵文字を追加"
            onMouseDown={(ev) => {
              ev.preventDefault()
              setShowAddEmojiModal(true)
            }}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[19px] text-ink-subtle hover:bg-surface-muted"
          >
            ＋
          </button>
        </div>
      )}
      {showAddEmojiModal && (
        <AddCustomEmojiModal
          onClose={() => setShowAddEmojiModal(false)}
          onCreated={() => {
            void mutateCustomEmoji()
            setShowAddEmojiModal(false)
          }}
        />
      )}
      {showPollModal && onCreatePoll && (
        <CreatePollModal
          onClose={() => setShowPollModal(false)}
          onCreate={async (question, options) => {
            await onCreatePoll(question, options)
          }}
        />
      )}
      {scheduleOpen && (
        <div className="absolute bottom-full right-0 z-40 mb-2 w-[260px] rounded-xl border border-line-strong bg-surface p-3 shadow-[0_12px_30px_rgba(16,24,40,0.18)]">
          <div className="mb-2 text-[12.5px] font-bold text-ink">送信日時を指定</div>
          <div className="flex gap-1.5">
            <input
              type="date"
              value={scheduleDate}
              onChange={(e) => setScheduleDate(e.target.value)}
              className="w-1/2 rounded-md border border-line-strong px-2 py-1.5 text-[12px] text-ink outline-none"
            />
            <input
              type="time"
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
              className="w-1/2 rounded-md border border-line-strong px-2 py-1.5 text-[12px] text-ink outline-none"
            />
          </div>
          <div className="mt-2 text-[11px] leading-relaxed text-ink-subtle">
            指定した日時に自動的に送信されます。送信されるまでは自分だけが内容を確認・キャンセルできます。
          </div>
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setScheduleOpen(false)}
              className="rounded-md border border-line-strong px-2.5 py-1 text-[11.5px] text-ink-muted"
            >
              キャンセル
            </button>
            <button
              type="button"
              disabled={scheduling}
              onClick={confirmSchedule}
              className="rounded-md bg-accent-600 px-2.5 py-1 text-[11.5px] font-bold text-white disabled:opacity-40"
            >
              予約する
            </button>
          </div>
        </div>
      )}
      {linkOpen && (
        <div
          className="absolute bottom-full left-0 z-40 mb-2 w-[280px] rounded-xl border border-line-strong bg-surface p-3 shadow-[0_12px_30px_rgba(16,24,40,0.18)]"
          onKeyDown={(e) => {
            // コンテナ全体で拾うことで、フォーカスがテキスト欄・URL欄・キャンセル/挿入ボタンの
            // いずれにあってもEscapeで閉じられるようにする（各inputだけにハンドラを付けると、
            // 「挿入」ボタンにフォーカスが移った状態でEscapeを押しても反応しない不具合があった）
            if (e.key === 'Escape') setLinkOpen(false)
          }}
        >
          <div className="mb-2 text-[12.5px] font-bold text-ink">リンクを挿入</div>
          <label className="mb-0.5 block text-[11px] font-semibold text-ink-subtle">テキスト</label>
          <input
            type="text"
            value={linkText}
            onChange={(e) => setLinkText(e.target.value)}
            placeholder="表示する文字列（省略時はURLを表示）"
            className="mb-1.5 w-full rounded-md border border-line-strong px-2 py-1.5 text-[12px] text-ink outline-none"
          />
          <label className="mb-0.5 block text-[11px] font-semibold text-ink-subtle">URL</label>
          <input
            type="text"
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                confirmLink()
              }
            }}
            placeholder="https://"
            autoFocus
            className="w-full rounded-md border border-line-strong px-2 py-1.5 text-[12px] text-ink outline-none"
          />
          <div className="mt-2.5 flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setLinkOpen(false)}
              className="rounded-md border border-line-strong px-2.5 py-1 text-[11.5px] text-ink-muted"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={confirmLink}
              className="rounded-md bg-accent-600 px-2.5 py-1 text-[11.5px] font-bold text-white"
            >
              挿入
            </button>
          </div>
        </div>
      )}
      {/* 書式ツールバー（太字・取り消し線・コード・箇条書き）は入力欄の「上」、ファイル添付・
          メンションは入力欄の「下」に配置する（ユーザーからの明示的な要望「役割が違うことを
          わかりやすくしたい」）。上段＝本文の見た目を変える書式、下段＝本文とは別に本文に
          付随させるもの（添付ファイル・宛先の指定）、という役割の違いを配置で示す */}
      <div className="mb-1.5 flex items-center gap-0.5">
        <button
          type="button"
          disabled={codeFormatActive}
          title="太字（選択範囲が無ければ、押している間タイプする文字が太字になります）"
          onMouseDown={(e) => {
            e.preventDefault()
            toggleFormatButton('bold')
          }}
          className={`flex h-7 w-7 items-center justify-center rounded-md text-[13px] font-black hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
            activeFormats.includes('bold') || pendingFormats.includes('bold') ? 'bg-accent-50 text-accent-700' : 'text-ink-subtle'
          }`}
        >
          B
        </button>
        <button
          type="button"
          disabled={codeFormatActive}
          title="斜体（選択範囲が無ければ、押している間タイプする文字が斜体になります）"
          onMouseDown={(e) => {
            e.preventDefault()
            toggleFormatButton('italic')
          }}
          className={`flex h-7 w-7 items-center justify-center rounded-md text-[13px] font-bold italic hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
            activeFormats.includes('italic') || pendingFormats.includes('italic') ? 'bg-accent-50 text-accent-700' : 'text-ink-subtle'
          }`}
        >
          I
        </button>
        <button
          type="button"
          disabled={codeFormatActive}
          title="下線（選択範囲が無ければ、押している間タイプする文字に下線が付きます）"
          onMouseDown={(e) => {
            e.preventDefault()
            toggleFormatButton('underline')
          }}
          className={`flex h-7 w-7 items-center justify-center rounded-md text-[13px] font-bold underline hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
            activeFormats.includes('underline') || pendingFormats.includes('underline') ? 'bg-accent-50 text-accent-700' : 'text-ink-subtle'
          }`}
        >
          U
        </button>
        <button
          type="button"
          disabled={codeFormatActive}
          title="取り消し線（選択範囲が無ければ、押している間タイプする文字に取り消し線が付きます）"
          onMouseDown={(e) => {
            e.preventDefault()
            toggleFormatButton('strike')
          }}
          className={`flex h-7 w-7 items-center justify-center rounded-md text-[13px] font-bold line-through hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
            activeFormats.includes('strike') || pendingFormats.includes('strike') ? 'bg-accent-50 text-accent-700' : 'text-ink-subtle'
          }`}
        >
          S
        </button>
        <button
          type="button"
          title="リンク（テキストとURLを指定して挿入します）"
          onMouseDown={(e) => {
            e.preventDefault()
            toggleLinkPopover()
          }}
          className={`flex h-7 w-7 items-center justify-center rounded-md text-[13px] hover:bg-surface-muted ${
            linkOpen ? 'bg-accent-50 text-accent-700' : 'text-ink-subtle'
          }`}
        >
          🔗
        </button>
        <button
          type="button"
          disabled={otherFormatActive}
          title="コード（複数行を選択するとコードブロックになります。太字等とは組み合わせられません）"
          onMouseDown={(e) => {
            e.preventDefault()
            wrapCode()
          }}
          className={`flex h-7 w-7 items-center justify-center rounded-md font-mono text-[13px] font-bold hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
            codeFormatActive ? 'bg-accent-50 text-accent-700' : 'text-ink-subtle'
          }`}
        >
          {'</>'}
        </button>
        <button
          type="button"
          title="箇条書き（行頭に「- 」を付けます）"
          onMouseDown={(e) => {
            e.preventDefault()
            insertBulletList()
          }}
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-muted"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="4" cy="6" r="1.3" fill="currentColor" />
            <circle cx="4" cy="10" r="1.3" fill="currentColor" />
            <circle cx="4" cy="14" r="1.3" fill="currentColor" />
            <path d="M8 6h8M8 10h8M8 14h8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        <button
          type="button"
          title="引用（行頭に「> 」を付けます）"
          onMouseDown={(e) => {
            e.preventDefault()
            insertQuote()
          }}
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-muted"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <rect x="3" y="4" width="2" height="12" rx="1" fill="currentColor" />
            <path d="M8 6h9M8 10h9M8 14h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        data-placeholder={placeholder}
        onInput={handleInput}
        onCompositionEnd={handleCompositionEnd}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onClick={handleEditorClick}
        className="composer-editable relative w-full whitespace-pre-wrap break-words text-[13px] text-ink outline-none [scrollbar-gutter:stable]"
      />
      {(attachments.length > 0 || uploading) && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {attachments.map((a, i) => (
            <span
              key={`${a.storage_path}-${i}`}
              className="flex items-center gap-1.5 rounded-md border border-line-strong bg-surface-subtle px-2 py-1 text-[11.5px] text-ink-muted"
            >
              📎 {a.file_name}
              <span className="text-ink-subtle">({formatBytes(a.byte_size)})</span>
              <button
                type="button"
                onClick={() => removeAttachment(i)}
                title="添付を外す"
                className="text-ink-subtle hover:text-danger-text"
              >
                ✕
              </button>
            </span>
          ))}
          {uploading && (
            <span className="flex items-center gap-1.5 rounded-md border border-line-strong bg-surface-subtle px-2 py-1 text-[11.5px] text-ink-subtle">
              アップロード中...
            </span>
          )}
        </div>
      )}
      <div className="mt-2 flex items-center gap-0.5">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            pickFile(e.target.files?.[0] ?? null)
            e.target.value = ''
          }}
        />
        <button
          type="button"
          title="ファイルを添付（20MBまで）"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
          className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-muted disabled:opacity-40"
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path
              d="M13.5 7.5l-5 5a2.1 2.1 0 0 0 3 3l5.5-5.5a3.5 3.5 0 0 0-5-5L6.5 9.5a4.9 4.9 0 0 0 7 7"
              stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          title="絵文字を挿入"
          onMouseDown={(e) => {
            e.preventDefault()
            toggleEmojiPopover()
          }}
          className={`flex h-7 w-7 items-center justify-center rounded-md ${
            emojiOpen ? 'bg-accent-50 text-accent-700' : 'text-ink-subtle hover:bg-surface-muted'
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="7.3" cy="8.3" r="0.9" fill="currentColor" />
            <circle cx="12.7" cy="8.3" r="0.9" fill="currentColor" />
            <path d="M6.8 12a4 4 0 0 0 6.4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        {mentionCandidates && (
          <button
            type="button"
            title="メンション候補を表示"
            onMouseDown={(e) => {
              e.preventDefault()
              insertMentionTrigger()
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-muted"
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M13 10a3 3 0 1 1-1-2.2M13 10v1.3a1.7 1.7 0 0 0 3.4 0V10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {onCreatePoll && (
          <button
            type="button"
            title="アンケートを作成"
            onMouseDown={(e) => {
              e.preventDefault()
              setShowPollModal(true)
            }}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-muted"
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 15V9M10 15V5M15 15v-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {canSchedule && (
          <button
            type="button"
            title="送信日時を指定"
            onMouseDown={(e) => {
              e.preventDefault()
              toggleSchedulePopover()
            }}
            className={`ml-auto flex h-7 w-7 items-center justify-center rounded-md ${
              scheduleOpen ? 'bg-accent-50 text-accent-700' : 'text-ink-subtle hover:bg-surface-muted'
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10 6v4l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        <button
          type="button"
          title="Ctrl+Enter（Macは⌘+Enter）でも送信できます"
          disabled={sending || uploading || !hasContent}
          onClick={send}
          className={`rounded-[7px] bg-accent-600 px-4 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-40 ${
            canSchedule ? '' : 'ml-auto'
          }`}
        >
          送信
        </button>
      </div>
    </div>
  )
}
