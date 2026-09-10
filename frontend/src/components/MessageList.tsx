import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { avatarColorFor } from '../lib/avatarColor'
import { useMe } from '../hooks/useMe'
import { apiFetch } from '../lib/api'
import { useToast } from './Toast'
import { useConfirm } from './ui/ConfirmDialog'
import ProfileCard from './ProfileCard'
import { EMOJI_LIST } from './Composer'
import type { CitationPayload, MentionSourceMember, Message, MessageReaction } from '../types'

export function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function dayKey(iso: string) {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function formatDaySeparator(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })
}

// 絵文字だけのメッセージを大きく表示する（Slack・Discord等でよく見る「ジャンボ絵文字」表示。
// ユーザーからの明示的な要望「文章無しで絵文字だけで送ったら少し大きく表示されてほしい」）。
// 本文（前後の空白を除く）が絵文字・結合用の記号（異体字セレクタU+FE0F・ZWJ・肌の色modifier）
// ・空白のみで構成されている場合に大きく表示する。あまりに多い絵文字を並べて大きくすると
// かえって読みにくくなるため、EMOJI_ONLY_MAX_COUNT件を超える場合は対象外（通常サイズのまま）にする。
// 既知の限界: 数字＋U+FE0F＋U+20E3（囲み文字）で構成されるキーキャップ絵文字（1️⃣等）は数字が
// \p{Extended_Pictographic}に含まれないため判定対象外になる（この用途では稀なケースとして許容）
const EMOJI_ZWJ = String.fromCharCode(0x200d) // ゼロ幅結合子（🙇‍♂️等の結合絵文字に使われる）
const EMOJI_VARIATION_SELECTOR = String.fromCharCode(0xfe0f) // 異体字セレクタ（❤️等に使われる）
const EMOJI_ONLY_REGEX = new RegExp(
  `^(?:\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|${EMOJI_ZWJ}|${EMOJI_VARIATION_SELECTOR}|\\s)+$`,
  'u',
)
const EMOJI_COUNT_REGEX = /\p{Extended_Pictographic}/gu
const EMOJI_ONLY_MAX_COUNT = 10

export function isEmojiOnlyBody(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || !EMOJI_ONLY_REGEX.test(trimmed)) return false
  const count = (trimmed.match(EMOJI_COUNT_REGEX) ?? []).length
  return count > 0 && count <= EMOJI_ONLY_MAX_COUNT
}

function DaySeparator({ label }: { label: string }) {
  return (
    <div className="mx-5 my-2.5 flex items-center gap-2.5 text-[11px] font-semibold text-ink-subtle">
      <span className="h-px flex-1 bg-line" />
      {label}
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}

function UnreadDivider() {
  return (
    <div className="mx-5 my-2.5 flex items-center gap-2.5 text-[11px] font-semibold text-accent-700">
      <span className="h-px flex-1 bg-accent-600" />
      ここから未読メッセージ
      <span className="h-px flex-1 bg-accent-600" />
    </div>
  )
}

// URLの自動リンク化（ユーザーからの明示的な要望「URLを送ったらクリックできるようになり、実際に
// そのサイトに飛べるようにしたい」）。http(s)://から始まり、URLとして妥当な文字（RFC3986の
// unreserved/reserved文字相当）が続く範囲を1つのURLとして検出する。日本語文字はこの文字クラスに
// 含まれないため、「詳細はhttps://example.comを見てください」のような文中URLでも「を見てください」
// まで巻き込むことはない。ただし文字クラス自体には「)」「.」「,」等の区切り文字も含むため、
// 「(https://example.com)。」のように文の区切りとして使われた記号を誤って含めてしまうことがあり、
// これを避けるため末尾の句読点的な記号は検出後に切り落とす（開き括弧との対応までは見ない簡易版、
// Slack等の実装と同程度の精度）
const URL_REGEX = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/g
const URL_TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/

function findUrlMatches(text: string): { start: number; end: number; url: string }[] {
  const results: { start: number; end: number; url: string }[] = []
  for (const m of text.matchAll(URL_REGEX)) {
    let url = m[0]
    let end = (m.index ?? 0) + url.length
    const trailing = url.match(URL_TRAILING_PUNCTUATION)
    if (trailing) {
      url = url.slice(0, url.length - trailing[0].length)
      end -= trailing[0].length
    }
    if (url.length > 0) results.push({ start: m.index ?? 0, end, url })
  }
  return results
}

// 簡易書式（太字・斜体・下線・取り消し線・コード・箇条書き）。ユーザーからの明示的な要望「Slackの
// メッセージ入力欄と同じように、コードのボックス・下線・ボールド・箇条書きのような機能を付けたい」
// （2026-09-10最初の実装）と、続けて「コードボックスの中の文字は黒とは別の色にしてほしい。斜体や
// 下線もSlackにあったので実装したい」（同日追加）により拡張した。採用した記法はGFM（GitHub Flavored
// Markdown）風の`**太字**`・`` `コード` ``・``` ```コードブロック``` ```・行頭「- 」の箇条書き・
// `~~取り消し線~~`に加え、`_斜体_`（GFM標準の単一アンダースコア）・`++下線++`（標準Markdownに無い
// ため独自に定めた記法）を追加した。Slack自体のmrkdwn記法（単一`*`太字・単一`~`取り消し線）は、
// 日本語の波ダッシュ「〜」や文中で単発の`*`を使う文章との誤検出が多いため意図的に避けた（着手前に
// ユーザーへ確認し合意）。**単一アンダースコアの斜体には、Pythonのダンダーメソッド名（`__init__`
// 等）のような開発者間チャットにありがちな誤検出リスクがあるが、単一`*`（一般利用者の日常的な文章
// での強調表現との衝突が非常に多い）よりは狭い層にしか起きない・GFMの標準的な記法でもあるという
// 判断で受容した**（コードスパン内の文字は装飾を解釈しないため、`` `__init__` `` のようにバック
// クォートで囲めば誤検出は防げる）。下線の`++`記法も、既存の増分演算子`i++`のような単発の出現では
// マッチしない（`++`が対になって初めて反応する）ため実用上のリスクは小さいと判断した。コードブロック・
// 箇条書きは行を跨ぐ構造のため、メンション・URL・太字・斜体・下線・取り消し線・インラインコードと
// 同じ「本文中の位置に対するmatches」方式では扱えず、まず本文をコードブロック単位（1階層目）→
// 箇条書き行の連続単位（2階層目）に分割してから、残った通常の文章部分にだけ既存のインライン装飾
// （renderInlineSegment）を適用する2段階構成にした。コードスパン・コードブロックの中身は
// Markdownの一般的な挙動どおり、太字・斜体・下線・取り消し線・メンション・URLをさらに解釈しない
// （ネストした書式には対応しない、という簡易実装の範囲内の割り切り）。
// コード表示の背景色はbg-surface-subtleではなくbg-surface-mutedを使う（発言行のホバー背景が
// hover:bg-surface-subtleのため、同じ色にするとホバー時にコードの箱が消えて見えてしまうため）。
// コード表示の文字色は黒（ink）と紛れないよう専用のtext-code-text（index.css参照）を使う。
const CODE_BLOCK_REGEX = /```([\s\S]*?)```/g
const INLINE_CODE_REGEX = /`([^`\n]+)`/g
const BOLD_REGEX = /\*\*([\s\S]+?)\*\*/g
const STRIKE_REGEX = /~~([\s\S]+?)~~/g
const ITALIC_REGEX = /_([\s\S]+?)_/g
const UNDERLINE_REGEX = /\+\+([\s\S]+?)\+\+/g

function splitCodeBlocks(text: string): { type: 'code' | 'text'; content: string }[] {
  const segments: { type: 'code' | 'text'; content: string }[] = []
  let cursor = 0
  for (const m of text.matchAll(CODE_BLOCK_REGEX)) {
    const idx = m.index ?? 0
    if (idx > cursor) segments.push({ type: 'text', content: text.slice(cursor, idx) })
    // 先頭・末尾の改行だけ1つ取り除く（```\nコード\n``` と書いたときの見た目上の余白を除去する、
    // GFMの一般的な扱い）
    segments.push({ type: 'code', content: m[1].replace(/^\n/, '').replace(/\n$/, '') })
    cursor = idx + m[0].length
  }
  if (cursor < text.length) segments.push({ type: 'text', content: text.slice(cursor) })
  return segments.length > 0 ? segments : [{ type: 'text', content: text }]
}

function splitBulletLists(
  text: string,
): ({ type: 'list'; items: string[] } | { type: 'text'; content: string })[] {
  const segments: ({ type: 'list'; items: string[] } | { type: 'text'; content: string })[] = []
  let textBuf: string[] = []
  let listBuf: string[] = []
  const flushText = () => {
    if (textBuf.length > 0) segments.push({ type: 'text', content: textBuf.join('\n') })
    textBuf = []
  }
  const flushList = () => {
    if (listBuf.length > 0) segments.push({ type: 'list', items: listBuf })
    listBuf = []
  }
  for (const line of text.split('\n')) {
    const m = /^- (.+)$/.exec(line)
    if (m) {
      flushText()
      listBuf.push(m[1])
    } else {
      flushList()
      textBuf.push(line)
    }
  }
  flushText()
  flushList()
  return segments
}

// 太字・取り消し線・インラインコード・メンション・URLの解決（優先度: コード＞太字/取り消し線＞
// メンション＞URL）。同じ範囲に複数の候補が重なる場合は優先度が高い方を採用し、負けた側は
// 描画しない（例: コードスパンの中に偶然「**」が含まれていても太字化しない）。usedMentionNeedles
// は人間宛メンション（@display_name_snapshot）をメッセージ全体で1回だけハイライトするための
// 呼び出し元との共有状態（コードブロック・箇条書きで本文が複数のセグメントに分かれても、
// 従来どおり「最初に見つかった1箇所だけ」という挙動を保つため）
function renderInlineSegment(
  text: string,
  mentionDefs: { needle: string; label: string }[],
  usedMentionNeedles: Set<string>,
  aiPersonaName: string | undefined,
  keyPrefix: string,
): ReactNode[] {
  type Candidate = { start: number; end: number; priority: number; render: (key: string) => ReactNode }
  const candidates: Candidate[] = []

  for (const m of text.matchAll(INLINE_CODE_REGEX)) {
    const start = m.index ?? 0
    const content = m[1]
    candidates.push({
      start,
      end: start + m[0].length,
      priority: 0,
      render: (key) => (
        <code key={key} className="rounded border border-line bg-surface-muted px-1 py-0.5 font-mono text-[12.5px] text-code-text">
          {content}
        </code>
      ),
    })
  }
  for (const m of text.matchAll(BOLD_REGEX)) {
    const start = m.index ?? 0
    const content = m[1]
    candidates.push({
      start,
      end: start + m[0].length,
      priority: 1,
      render: (key) => <strong key={key} className="font-bold">{content}</strong>,
    })
  }
  for (const m of text.matchAll(ITALIC_REGEX)) {
    const start = m.index ?? 0
    const content = m[1]
    candidates.push({
      start,
      end: start + m[0].length,
      priority: 1,
      render: (key) => <em key={key} className="italic">{content}</em>,
    })
  }
  for (const m of text.matchAll(UNDERLINE_REGEX)) {
    const start = m.index ?? 0
    const content = m[1]
    candidates.push({
      start,
      end: start + m[0].length,
      priority: 1,
      render: (key) => <u key={key} className="underline">{content}</u>,
    })
  }
  for (const m of text.matchAll(STRIKE_REGEX)) {
    const start = m.index ?? 0
    const content = m[1]
    candidates.push({
      start,
      end: start + m[0].length,
      priority: 1,
      render: (key) => <s key={key} className="line-through">{content}</s>,
    })
  }
  for (const def of mentionDefs) {
    if (usedMentionNeedles.has(def.needle)) continue
    const idx = text.indexOf(def.needle)
    if (idx !== -1) {
      usedMentionNeedles.add(def.needle)
      candidates.push({
        start: idx,
        end: idx + def.needle.length,
        priority: 2,
        render: (key) => (
          <span key={key} className="rounded bg-accent-100 px-1 font-semibold text-accent-700">
            {def.label}
          </span>
        ),
      })
    }
  }
  if (aiPersonaName) {
    const needle = `@${aiPersonaName}`
    let idx = text.indexOf(needle)
    while (idx !== -1) {
      candidates.push({
        start: idx,
        end: idx + needle.length,
        priority: 2,
        render: (key) => (
          <span key={key} className="rounded bg-accent-100 px-1 font-semibold text-accent-700">
            {needle}
          </span>
        ),
      })
      idx = text.indexOf(needle, idx + needle.length)
    }
  }
  for (const u of findUrlMatches(text)) {
    candidates.push({
      start: u.start,
      end: u.end,
      priority: 3,
      render: (key) => (
        <a
          key={key}
          href={u.url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-accent-700 underline hover:text-accent-800"
        >
          {u.url}
        </a>
      ),
    })
  }

  candidates.sort((a, b) => a.priority - b.priority || a.start - b.start)
  const accepted: Candidate[] = []
  for (const c of candidates) {
    if (accepted.some((a) => c.start < a.end && a.start < c.end)) continue
    accepted.push(c)
  }
  accepted.sort((a, b) => a.start - b.start)

  if (accepted.length === 0) return [text]
  const nodes: ReactNode[] = []
  let cursor = 0
  accepted.forEach((c, i) => {
    if (c.start > cursor) nodes.push(text.slice(cursor, c.start))
    nodes.push(c.render(`${keyPrefix}-${i}`))
    cursor = c.end
  })
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

// F-41 @メンションの描画。本文中の「@display_name_snapshot」を検出し、target_user_idを
// 現在のチャンネル参加者一覧で解決した最新の表示名でハイライト表示する（05-1_詳細設計書_DB設計.html
// 3.7節「表示時はtarget_user_idを解決して現在の表示名・アイコンを描画」）。A-62プロフィール編集の
// 実装（F-39）により、対象者が後から表示名を変更した場合はdisplay_name_snapshotと現在名が食い違う
// ことがあり、この場合も現在名の方で描画し直す（本文中の静的テキストは検索の起点にのみ使う）。
// あわせてURLの自動リンク化（上記）もここで統合する。
export function renderMessageBody(
  body: string,
  blocks: Message['blocks'],
  members?: MentionSourceMember[],
  aiPersonaName?: string,
): ReactNode {
  const mentions = (blocks ?? []).filter(
    (b): b is { block_type: 'mention'; payload: { target_user_id: string; display_name_snapshot: string }; sort_order: number } =>
      b.block_type === 'mention',
  )
  const mentionDefs = mentions.map((block) => {
    const current = members?.find((m) => m.id === block.payload.target_user_id)?.name
    return {
      needle: `@${block.payload.display_name_snapshot}`,
      label: `@${current ?? block.payload.display_name_snapshot}`,
    }
  })
  const usedMentionNeedles = new Set<string>()

  const nodes: ReactNode[] = []
  splitCodeBlocks(body).forEach((seg, segIdx) => {
    if (seg.type === 'code') {
      nodes.push(
        <pre
          key={`code-${segIdx}`}
          className="my-1 overflow-x-auto whitespace-pre rounded-md border border-line bg-surface-muted px-2.5 py-2 font-mono text-[12.5px] leading-[1.6] text-code-text"
        >
          {seg.content}
        </pre>,
      )
      return
    }
    splitBulletLists(seg.content).forEach((ls, lsIdx) => {
      if (ls.type === 'list') {
        nodes.push(
          <ul key={`list-${segIdx}-${lsIdx}`} className="my-1 list-disc space-y-0.5 pl-5">
            {ls.items.map((item, ii) => (
              <li key={ii}>
                {renderInlineSegment(item, mentionDefs, usedMentionNeedles, aiPersonaName, `${segIdx}-${lsIdx}-li${ii}`)}
              </li>
            ))}
          </ul>,
        )
      } else {
        nodes.push(...renderInlineSegment(ls.content, mentionDefs, usedMentionNeedles, aiPersonaName, `${segIdx}-${lsIdx}`))
      }
    })
  })
  return nodes.length > 0 ? nodes : body
}

// Avatarが実際に必要とするフィールドだけを抜き出した形（Message全体を要求すると、S-05検索結果の
// ような別の形のデータ（SearchResultItem）から呼べなくなるため。ユーザーからの要望で検索結果にも
// 同じアイコン表示を追加した際にこの形へ広げた）
export type AvatarSource = Pick<
  Message,
  'sender_type' | 'sender_user_id' | 'sender_name' | 'sender_picture_url' | 'bot_icon' | 'id'
>

export function Avatar({
  message,
  onClick,
  size = 34,
}: {
  message: AvatarSource
  onClick?: (e: MouseEvent<HTMLElement>) => void
  /** 既定34px（会話ログ本来のサイズ）。S-05検索結果のような密な一覧から呼ぶ場合は縮小できる
   * （ユーザーからの要望で検索結果にも同じアイコン表示を追加した際に追加。サイズはTailwindの
   * 任意値クラスだと動的値がビルド時にスキャンされないため、幅・高さ・角丸はstyleで指定する） */
  size?: number
}) {
  // アイコン画像を設定済みならそれを表示し、無ければ種別ごとのフォールバックにする
  // （画面設計11.6節 Avatarコンポーネント定義。メッセージ一覧・サイドバー・メンバー一覧等で共通の考え方）。
  // BOT発言（F-36定期投稿・F-38トリガー・F-43システム通知）・AI発言はいずれも、画像アップロード済みか
  // どうかに関わらず常に角丸四角（既定サイズでrounded-[9px]相当）で表示し、人間の円形アイコンと形で
  // 区別できるようにする（BOT/AIかどうかをアイコンの形だけでも判別できるようにする設計判断。当初は
  // AIも円形だったが、ペルソナアイコン画像を設定すると実在の人物と見分けがつかなくなるという
  // ユーザーからの指摘を受けて角丸四角に変更した）。BOTの優先順位は送り主アイコン画像（bot_icon_url）
  // →bot_icon（絵文字）→🔔（F-43システム通知と同じ既定表示）。AIの優先順位はペルソナアイコン→
  // 「AI」のグラデーション表示。
  const boxStyle = { width: size, height: size, borderRadius: Math.round((size * 9) / 34) }
  if (message.sender_type === 'bot') {
    return (
      <div className="flex-none overflow-hidden bg-bot-bg" style={boxStyle}>
        {message.sender_picture_url ? (
          <img src={message.sender_picture_url} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center"
            style={{ fontSize: Math.round(size * 0.47) }}
          >
            {message.bot_icon || '🔔'}
          </div>
        )}
      </div>
    )
  }
  if (message.sender_type === 'ai') {
    return (
      <div className="flex-none overflow-hidden bg-gradient-to-br from-accent-600 to-accent-700" style={boxStyle}>
        {message.sender_picture_url ? (
          <img src={message.sender_picture_url} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
        ) : (
          <div
            className="flex h-full w-full items-center justify-center font-bold text-white"
            style={{ fontSize: Math.round(size * 0.32) }}
          >
            AI
          </div>
        )}
      </div>
    )
  }
  if (message.sender_picture_url) {
    return (
      <img
        src={message.sender_picture_url}
        alt=""
        referrerPolicy="no-referrer"
        onClick={onClick}
        className={`flex-none rounded-full object-cover ${onClick ? 'cursor-pointer' : ''}`}
        style={{ width: size, height: size }}
      />
    )
  }
  const seed = message.sender_user_id ?? message.sender_name ?? message.id
  return (
    <div
      onClick={onClick}
      className={`flex flex-none items-center justify-center rounded-full font-bold text-white ${onClick ? 'cursor-pointer' : ''}`}
      style={{ background: avatarColorFor(seed), width: size, height: size, fontSize: Math.round(size * 0.35) }}
    >
      {(message.sender_name ?? '?').slice(0, 1)}
    </div>
  )
}

// F-07 ファイル共有。ダウンロードはA-22（/api/attachments/{id}）を通常のリンク遷移で叩く
// （同一オリジンのためCookieが自動的に付き、A-22側の参加者チェックを経てFileResponseが返る）
function AttachmentList({ attachments }: { attachments: Message['attachments'] }) {
  if (!attachments || attachments.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {attachments.map((a) => (
        <a
          key={a.id}
          href={`/api/attachments/${a.id}`}
          className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px] text-ink hover:border-line-strong hover:bg-surface-subtle"
        >
          📎 <span className="max-w-[220px] truncate">{a.file_name}</span>
          <span className="text-ink-subtle">({formatBytes(a.byte_size)})</span>
        </a>
      ))}
    </div>
  )
}

// 絵文字リアクション（ユーザーからの明示的な要望「Slackのように発言一つ一つに対して絵文字で
// リアクションできるようにしたい」）。要望どおり「返信・削除ボタンの左隣によく使いそうな絵文字を
// 数種類、その横に絵文字一覧を開くボタン」という構成にした。クイックリアクションは投稿欄の絵文字
// ボタン（Composer.tsx）と同じEMOJI_LISTの中から特によく使われそうな5種を選んだ固定リスト。
export const QUICK_REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀']

// クイックリアクションボタン＋「もっと見る」（絵文字ピッカーを開く）ボタン。返信・削除ボタンと
// 同じホバー時アクションバーに置く想定（呼び出し元がgroup-hover等の表示制御を行う）
export function ReactionQuickButtons({
  onToggle,
  pickerOpen,
  onTogglePicker,
}: {
  onToggle: (emoji: string) => void
  pickerOpen: boolean
  onTogglePicker: () => void
}) {
  return (
    <>
      {QUICK_REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onToggle(emoji)}
          title={`${emoji}でリアクション`}
          className="flex h-6 w-6 items-center justify-center rounded text-[13px] hover:bg-surface-muted"
        >
          {emoji}
        </button>
      ))}
      <button
        type="button"
        onClick={onTogglePicker}
        title="絵文字を選んでリアクション"
        className={`flex h-6 w-6 items-center justify-center rounded ${
          pickerOpen ? 'bg-accent-50 text-accent-700' : 'text-ink-subtle hover:bg-surface-muted'
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7.2" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="7.3" cy="8.3" r="0.9" fill="currentColor" />
          <circle cx="12.7" cy="8.3" r="0.9" fill="currentColor" />
          <path d="M6.8 12a4 4 0 0 0 6.4 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
    </>
  )
}

// クイックリアクション横の「もっと見る」ボタンから開く絵文字グリッド（Composer.tsxの絵文字
// ピッカーと同じ見た目・EMOJI_LISTを共有）。位置は呼び出し元がラップするdivのclassNameで決める
export function EmojiGridPopover({ onSelect }: { onSelect: (emoji: string) => void }) {
  return (
    <div className="grid max-h-[200px] w-[240px] grid-cols-8 gap-0.5 overflow-y-auto rounded-xl border border-line-strong bg-surface p-1.5 shadow-[0_12px_30px_rgba(16,24,40,0.18)]">
      {EMOJI_LIST.map((emoji, i) => (
        <button
          key={`${emoji}-${i}`}
          type="button"
          onClick={() => onSelect(emoji)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[15px] hover:bg-surface-muted"
        >
          {emoji}
        </button>
      ))}
    </div>
  )
}

// 発言本文の下に表示するリアクション一覧（絵文字＋件数のピル）。既に自分が付けている絵文字は
// アクセントカラーで強調し、クリックで同じ絵文字をもう一度トグル（削除）できる。誰が付けたかは
// タイトル属性（ホバー時のツールチップ）で見られるようにした
export function ReactionPills({
  reactions,
  onToggle,
}: {
  reactions: MessageReaction[] | undefined
  onToggle: (emoji: string) => void
}) {
  if (!reactions || reactions.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          onClick={() => onToggle(r.emoji)}
          title={r.user_names.join('、')}
          className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[12px] ${
            r.reacted_by_me
              ? 'border-accent-600 bg-accent-50 text-accent-700'
              : 'border-line-strong bg-surface text-ink-muted hover:bg-surface-subtle'
          }`}
        >
          <span>{r.emoji}</span>
          <span className="text-[11px] font-semibold">{r.count}</span>
        </button>
      ))}
    </div>
  )
}

// S-03・S-04共通の発言一覧（詳細設計書 画面設計11.3節）。スクロールコンテナは呼び出し元が持つ
// （S-04のthread-bodyは元発言・件数・返信一覧をひとつのスクロール領域として扱うため）。
// onOpenThreadを渡すと「N件の返信」導線とホバー時の「返信」ボタンを表示する（S-04スレッド表示への導線）。
// 削除（A-12）は投稿者本人またはadminのみホバー時に表示し、確認ダイアログを経由する。
export default function MessageList({
  messages,
  emptyMessage,
  onOpenThread,
  openThreadId,
  onDeleted,
  onReactionToggled,
  showDaySeparators = true,
  members,
  unreadDividerMessageId,
  aiPersonaName,
  highlightMessageId,
}: {
  messages: Message[]
  emptyMessage?: string
  onOpenThread?: (messageId: string) => void
  openThreadId?: string | null
  onDeleted?: (messageId: string) => void
  /** A-75リアクショントグルの直後、呼び出し元（useMessages.updateMessageReactions等）にその場
   * での反映を任せるためのコールバック（onDeleted/onOpenThreadと同じ「楽観的更新は呼び出し元が
   * 担う」パターン）。渡さない場合は次のポーリングで自然に反映される（ThreadPanelの元発言ヘッダー
   * 等、独立した表示のみの箇所を想定） */
  onReactionToggled?: (messageId: string, reactions: Message['reactions']) => void
  /** S-04スレッド返信欄では表示しない（画面モックアップに合わせる。既定はtrue） */
  showDaySeparators?: boolean
  /** F-41 @メンションの表示名解決に使う（チャンネル参加者一覧。DM会話では渡さない） */
  members?: MentionSourceMember[]
  /** このメッセージの直前に「ここから未読メッセージ」区切り線を表示する（useUnreadDivider） */
  unreadDividerMessageId?: string | null
  /** S-05横断検索の結果クリックでジャンプしてきた発言。見つかり次第1回だけスクロールし、
   * 薄いオレンジ背景でフラッシュ表示する（ユーザーからの明示的な要望）。呼び出し元
   * （ChannelView/DmView/ThreadPanel）がURLの?highlight=から渡す */
  highlightMessageId?: string | null
  /** AIメンション（本文中の「@ペルソナ名」）のハイライトに使う（チャンネルAIのpersona_name。
   * DM会話では渡さない。channel.ai_persona_nameを参照） */
  aiPersonaName?: string
}) {
  const { me } = useMe()
  const confirm = useConfirm()
  const toast = useToast()
  // F-40 プロフィールカード。開いている対象はメッセージid単位で持つ（表示するのはsender_user_idの
  // プロフィール）。anchorはクリックした要素の座標で、画面下寄りの発言（一番下の投稿欄近く）で
  // カードが投稿欄の裏に隠れないよう、ProfileCard側でdocument.bodyへポータル配置する際の基準にする
  const [profileFor, setProfileFor] = useState<{ id: string; anchor: DOMRect } | null>(null)
  const openProfile = (id: string, e: MouseEvent<HTMLElement>) =>
    setProfileFor({ id, anchor: e.currentTarget.getBoundingClientRect() })

  // S-05検索結果からのハイライトジャンプ（ユーザーからの明示的な要望）。目的の発言がmessagesに
  // 現れた時点（初回は`around=`取得の応答待ちのため即座には無い）で1回だけスクロールする。
  // scrolledForを見て同じhighlightMessageIdに対しては再スクロールしない（3秒ごとのポーリングで
  // messagesが更新されるたびに毎回スクロールされて読んでいる位置が飛ぶのを防ぐ）
  const scrolledFor = useRef<string | null>(null)
  useEffect(() => {
    if (!highlightMessageId || scrolledFor.current === highlightMessageId) return
    const el = document.getElementById(`message-${highlightMessageId}`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    scrolledFor.current = highlightMessageId
  }, [highlightMessageId, messages])

  const deleteMessage = async (messageId: string) => {
    const ok = await confirm({
      title: '発言を削除',
      message: 'この発言を削除しますか？ この操作は取り消せません。',
      confirmLabel: '削除する',
      danger: true,
    })
    if (!ok) return
    try {
      await apiFetch(`/api/messages/${messageId}`, { method: 'DELETE' })
      onDeleted?.(messageId)
      toast('発言を削除しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '削除に失敗しました', 'error')
    }
  }

  // 絵文字リアクション（A-75、ユーザーからの明示的な要望）。絵文字ピッカーはメッセージid単位で
  // 開閉を管理する（同時に複数開く必要は無いため、単一のstateで足りる）
  const [emojiPickerFor, setEmojiPickerFor] = useState<string | null>(null)
  const toggleReaction = async (messageId: string, emoji: string) => {
    setEmojiPickerFor(null)
    try {
      const res = await apiFetch<{ reactions: Message['reactions'] }>(
        `/api/messages/${messageId}/reactions/toggle`,
        { method: 'POST', body: JSON.stringify({ emoji }) },
      )
      onReactionToggled?.(messageId, res.reactions)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'リアクションに失敗しました', 'error')
    }
  }

  // A-74: 生成中のAI発言を強制的に中断する（ユーザーからの明示的な要望「AIの生成をアプリ上で
  // 強制的に中断させる機能がほしい」。バックエンドプロセスの再起動と重なると「生成中」のまま
  // 固まり続けることがあった実際の障害を受けて追加）。所有者という概念が無いAI発言のため、
  // 削除ボタン（投稿者本人/adminのみホバー時に表示）と異なり、参加者なら誰でも常に押せるようにする。
  // 中断後の本文は次の3秒ポーリングで自然に反映されるため、ここでは楽観的更新はしない
  // （AI応答が完了した際の表示更新も同じくポーリング任せで、一貫している）
  const [cancelling, setCancelling] = useState<string | null>(null)
  const cancelGeneration = async (messageId: string) => {
    setCancelling(messageId)
    try {
      await apiFetch(`/api/messages/${messageId}/cancel-generation`, { method: 'POST' })
      toast('生成を中断しました')
    } catch (e) {
      toast(e instanceof Error ? e.message : '中断に失敗しました', 'error')
    } finally {
      setCancelling(null)
    }
  }

  if (messages.length === 0) {
    return emptyMessage ? <p className="px-5 py-3 text-sm text-ink-subtle">{emptyMessage}</p> : null
  }

  return (
    <>
      {messages.map((m, i) => {
        // システム通知（F-43）は参加・退出の記録として残すことに意味があるため、返信・削除の対象外とする
        // （F-36定期投稿・F-38自動応答トリガーは内容のあるBOT発言のため対象外にしない。基本設計書6.2節「設計判断」）
        const isSystemNotice = m.sender_type === 'bot' && m.sender_name === 'システム通知'
        const canDelete = !isSystemNotice && !!me && (m.sender_user_id === me.id || me.role === 'admin')
        const showReplyButton = !isSystemNotice && onOpenThread && !(m.thread_reply_count ?? 0)
        // リアクションは投稿者本人限定にせず、この会話にいる誰でも付けられる（Slack等と同じ一般的な
        // 挙動）。システム通知（参加・退出の記録）へのリアクションも、返信・削除と異なり記録の
        // 信頼性を損なわないため対象外にしない（バックエンドA-75も同じ判断）
        const canReact = !!me
        const isNewDay = showDaySeparators && (i === 0 || dayKey(messages[i - 1].created_at) !== dayKey(m.created_at))

        return (
          <div key={m.id}>
            {isNewDay && <DaySeparator label={formatDaySeparator(m.created_at)} />}
            {unreadDividerMessageId === m.id && <UnreadDivider />}
            <div
              id={`message-${m.id}`}
              className={`group relative flex gap-2.5 px-5 py-[7px] transition-colors duration-700 ${
                highlightMessageId === m.id
                  ? 'bg-bot-bg'
                  : openThreadId === m.id
                    ? 'bg-accent-50'
                    : 'hover:bg-surface-subtle'
              }`}
            >
              <Avatar
                message={m}
                onClick={
                  m.sender_type === 'human' && m.sender_user_id
                    ? (e) => openProfile(m.id, e)
                    : undefined
                }
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-[7px]">
                  <span
                    onClick={
                      m.sender_type === 'human' && m.sender_user_id ? (e) => openProfile(m.id, e) : undefined
                    }
                    className={`text-[13px] font-bold text-ink ${
                      m.sender_type === 'human' && m.sender_user_id ? 'cursor-pointer hover:underline' : ''
                    }`}
                  >
                    {m.sender_name ?? '(不明)'}
                  </span>
                  {m.sender_type === 'bot' && (
                    <span className="rounded bg-bot-bg px-1.5 py-0.5 text-[10px] font-bold text-bot-text">BOT</span>
                  )}
                  {m.sender_type === 'ai' && (
                    <span className="rounded bg-accent-100 px-1.5 py-0.5 text-[10px] font-bold text-accent-700">
                      AI
                    </span>
                  )}
                  {m.is_summary && (
                    // F-14 要約ボタンで生成された発言だと分かるようにするバッジ（ユーザーからの要望）。
                    // ChannelView/ThreadPanelの「📝 要約」ボタンと同じ絵文字・配色（AI発言のaccentトーン）
                    // にして、この発言がその機能で作られたことを一目で結びつけられるようにした
                    <span className="rounded bg-accent-100 px-1.5 py-0.5 text-[10px] font-bold text-accent-700">
                      📝 要約
                    </span>
                  )}
                  <span className="text-[11px] text-ink-subtle">{formatTime(m.created_at)}</span>
                </div>
                {m.generation_status === 'generating' ? (
                  <div className="mt-0.5 flex items-center gap-2 text-[12.5px] text-ink-subtle">
                    <span className="inline-flex items-center gap-1">
                      <span className="inline-flex gap-[3px]">
                        <span className="ai-typing-dot h-[5px] w-[5px] rounded-full bg-ink-subtle" />
                        <span className="ai-typing-dot h-[5px] w-[5px] rounded-full bg-ink-subtle [animation-delay:.2s]" />
                        <span className="ai-typing-dot h-[5px] w-[5px] rounded-full bg-ink-subtle [animation-delay:.4s]" />
                      </span>
                      生成中…
                    </span>
                    <button
                      type="button"
                      disabled={cancelling === m.id}
                      onClick={() => cancelGeneration(m.id)}
                      title="AIの生成をここで打ち切ります（数十分など、いつまでも終わらない場合に使えます）"
                      className="rounded border border-line-strong px-1.5 py-0.5 text-[11px] font-semibold text-ink-muted hover:border-danger-border hover:text-danger-text disabled:opacity-50"
                    >
                      ■ {cancelling === m.id ? '中断中…' : '中断'}
                    </button>
                  </div>
                ) : (
                  <div
                    className={`mt-0.5 whitespace-pre-wrap break-words text-ink ${
                      isEmojiOnlyBody(m.body) ? 'text-[32px] leading-snug' : 'text-[13.5px] leading-[1.75]'
                    }`}
                  >
                    {renderMessageBody(m.body, m.blocks, members, aiPersonaName)}
                  </div>
                )}
                {m.sender_type === 'ai' && m.generation_status !== 'generating' && (
                  // F-30 AI回答への注意喚起表示（基本設計書5.12節「S-03の各AI発言下部」、画面モックアップ
                  // S-03の`.ai-disclaimer`）。要件定義書REQ-N-04対応。ChannelSettings.tsxのDocScopeTabの
                  // ヒント文言が「どちらの設定でも常時表示されます」と既に説明していたが、実際には
                  // MessageList側の実装が無く表示されていなかった抜けを、ユーザーからの指摘を受けて
                  // 実装した（要約ボタン経由の発言（is_summary）も同じAI発言のため対象に含める）
                  <div className="mt-[7px] flex items-center gap-[5px] text-[11px] text-ink-subtle">
                    ⚠ AIの回答には誤りが含まれる場合があります。
                  </div>
                )}
                {/* F-20 回答根拠の提示（Slice 3、2026-09-09）。search_documentsが実際に参照した
                    文書をblock_type='citation'として表示する。生成中は（まだ根拠が確定していないため）表示しない */}
                {m.sender_type === 'ai' && m.generation_status !== 'generating' && (m.blocks ?? []).some((b) => b.block_type === 'citation') && (
                  <div className="mt-[5px] flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-ink-subtle">
                    <span>📄 参照:</span>
                    {(m.blocks ?? [])
                      .filter((b) => b.block_type === 'citation')
                      .map((b, i) => (
                        <span key={i} className="rounded bg-bot-bg px-1.5 py-0.5 text-bot-text">
                          {(b.payload as CitationPayload).folder_name}
                        </span>
                      ))}
                  </div>
                )}
                <AttachmentList attachments={m.attachments} />
                <ReactionPills reactions={m.reactions} onToggle={(emoji) => toggleReaction(m.id, emoji)} />
                {onOpenThread && (m.thread_reply_count ?? 0) > 0 && (
                  <button
                    type="button"
                    onClick={() => onOpenThread(m.id)}
                    className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-accent-700 hover:border-line-strong hover:bg-surface-subtle"
                  >
                    💬 {m.thread_reply_count}件の返信{openThreadId === m.id ? ' — スレッドを表示中' : ''}
                  </button>
                )}
              </div>
              {(canReact || showReplyButton || canDelete) && (
                // 常時flowに置くと表示/非表示の切替で下の発言がガタつくため、絶対配置でホバー時だけ重ねて出す。
                // リアクションのクイックボタン・絵文字ピッカーボタンは返信・削除ボタンの左隣に置く
                // （ユーザーからの明示的な要望どおりの配置）
                <div className="absolute right-4 top-1 hidden items-center gap-1 group-hover:flex">
                  {canReact && (
                    <ReactionQuickButtons
                      onToggle={(emoji) => toggleReaction(m.id, emoji)}
                      pickerOpen={emojiPickerFor === m.id}
                      onTogglePicker={() => setEmojiPickerFor((v) => (v === m.id ? null : m.id))}
                    />
                  )}
                  {showReplyButton && (
                    <button
                      type="button"
                      onClick={() => onOpenThread(m.id)}
                      className="rounded border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-muted shadow-sm hover:text-accent-700"
                    >
                      返信
                    </button>
                  )}
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => deleteMessage(m.id)}
                      className="rounded border border-line bg-surface px-2 py-0.5 text-[11px] text-ink-muted shadow-sm hover:text-danger-text"
                    >
                      削除
                    </button>
                  )}
                </div>
              )}
              {emojiPickerFor === m.id && (
                <div className="absolute right-4 top-8 z-40">
                  <EmojiGridPopover onSelect={(emoji) => toggleReaction(m.id, emoji)} />
                </div>
              )}
              {profileFor?.id === m.id && m.sender_user_id && (
                <ProfileCard
                  userId={m.sender_user_id}
                  onClose={() => setProfileFor(null)}
                  anchor={profileFor.anchor}
                />
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
