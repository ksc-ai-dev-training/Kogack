import type { CustomEmoji } from '../types'

// 投稿欄（Composer.tsx）をtextarea＋オーバーレイ方式からcontentEditableへ書き換えるための
// 純粋なDOM/Range操作関数群（Reactに一切依存しない）。ユーザーからの明示的な要望「カスタム
// 絵文字を普通の絵文字のように1文字として扱いたい」（矢印キー移動・Backspace・クリック位置決め
// のいずれも:aurora:という8文字の生テキストではなく1つの原子的な単位として振る舞ってほしい）を
// 受け、textareaの生テキストに画像を重ねて見せかけていた従来方式をやめ、実際にDOM上で
// `contenteditable="false"`のimg要素として原子ノード化する。
//
// 設計判断（着手前にAskUserQuestionでユーザーへ確認・承認済み）:
// - カスタム絵文字のみ原子ノード化する。メンション（@氏名・@channel・@here・AIメンション）は
//   引き続きプレーンテキストのままで、選択・確定した瞬間だけハイライト用<span>で囲む（継続的な
//   全文再スキャンは行わない）。「入力のたびにスタイル付きspanをDOMツリー全体で差分再構築しながら
//   カーソル/IME合成状態を壊さない」処理は自前contentEditable実装で最もバグりやすい領域
//   （Lexical等のライブラリが専用に解決している問題そのもの）であり、これを避けてリスクを
//   大きく減らす（Planサブエージェントによる設計精査の結論）。副作用として、メンション候補を
//   使わず「@Kogack AI」等を1文字ずつ手打ちした場合は青くハイライトされない（バックエンドの
//   メンション検出自体は独立した文字列一致のため機能には影響しない、表示上の制約のみ）。
// - 改行は<br>要素ではなく、テキストノード内の生の"\n"文字で表現する（エディタ側は
//   white-space:pre-wrapを指定するため、textareaと同じ見た目になる）。<br>境界ベースの
//   実装はブラウザ間の挙動差・trailing<br>のラウンドトリップ等で不具合が起きやすいとPlan
//   サブエージェントの精査で指摘されたため、生テキストのオフセットだけで完結するこの方式を
//   採用した（既存のMessageList.tsx等のwhitespace-pre-wrapレンダリングとも表現が一貫する）。
// - Undo/Redo（Ctrl+Z）は既知の制約としてネイティブ任せにする。絵文字挿入・メンション挿入・
//   書式ボタンによる操作の完全な取り消しは保証しない（取り消しスタックとの整合を取ろうとする
//   実装はしない。normalizeInvariantsはUndo後にDOMの不変条件を壊れたまま放置しないための
//   軽量な修復パスに留まる）。

const EMOJI_ATTR = 'data-emoji-name'
const MENTION_ATTR = 'data-mention'

/** ショートコード正規表現（MessageList.tsx・旧Composer.tsxのfindCustomEmojiHighlightsと同じ規則） */
const SHORTCODE_RE = /:([a-zA-Z0-9_+-]{2,24}):/g

function isEmojiNode(node: Node): node is HTMLImageElement {
  return node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'IMG' && (node as Element).hasAttribute(EMOJI_ATTR)
}

/** 原子絵文字ノードの生成。バブルの外にラップせず裸のimgのまま（wrapper要素を挟むと
 * プログラムによるRange.deleteContents()で「imgは消えるが空のwrapperが残る」ゾンビノード事故が
 * 起きやすいとPlanサブエージェントの精査で指摘されたため、意図的に裸のまま挿入する）。 */
function createEmojiNode(name: string, imageUrl: string): HTMLImageElement {
  const img = document.createElement('img')
  img.src = imageUrl
  img.alt = `:${name}:`
  img.setAttribute(EMOJI_ATTR, name)
  img.contentEditable = 'false'
  img.draggable = false
  img.className = '-mb-[4px] inline-block h-[22px] w-[22px] select-none object-contain align-text-bottom'
  return img
}

/** メンションハイライト用span（挿入時点のみ付与、継続的な再スキャンはしない）。既存の
 * MessageList.tsx/旧オーバーレイと同じ配色トークン（bg-accent-300）を使う。 */
function createMentionSpan(displayText: string): HTMLSpanElement {
  const span = document.createElement('span')
  span.setAttribute(MENTION_ATTR, 'true')
  span.className = 'rounded-[3px] bg-accent-300 text-accent-700'
  span.textContent = displayText
  return span
}

/** シリアライズ: DOM→プレーンテキスト。テキストノードはそのまま、原子絵文字imgは`:name:`へ、
 * メンションspanは中身のテキストをそのまま透過する（spanは装飾のみで実体はプレーンテキストの
 * ため、activeMentionsInの`text.includes(...)`判定は従来どおりこの出力に対して機能する）。
 * 想定外の<br>が紛れ込んだ場合（外部リッチ貼り付けの取りこぼし等への保険）も改行として扱う。 */
export function domToPlainText(root: Node): string {
  let text = ''
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += (node as Text).data
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    if (isEmojiNode(node)) {
      text += `:${node.getAttribute(EMOJI_ATTR)}:`
      return
    }
    if ((node as Element).tagName === 'BR') {
      text += '\n'
      return
    }
    for (const child of Array.from(node.childNodes)) walk(child)
  }
  for (const child of Array.from(root.childNodes)) walk(child)
  return text
}

/** テキストを絵文字ショートコード解釈ありでDocumentFragmentへ変換する。下書き復元と、
 * 読み込み待ちだったcustomEmojiが到着した後の追いかけ変換の2箇所でのみ使う（通常の
 * プログラム的な挿入=書式マーカーやリンク構文・メンション名にはこの解釈をかけない。
 * 意図しない`:name:`風の文字列を誤って絵文字化しないため）。 */
export function deserializeFromText(text: string, customEmoji: CustomEmoji[]): DocumentFragment {
  const frag = document.createDocumentFragment()
  if (!text) return frag
  const byName = new Map(customEmoji.map((e) => [e.name.toLowerCase(), e]))
  let lastIndex = 0
  for (const m of text.matchAll(SHORTCODE_RE)) {
    const emoji = byName.get(m[1].toLowerCase())
    if (!emoji) continue
    const start = m.index ?? 0
    if (start > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, start)))
    frag.appendChild(createEmojiNode(m[1], emoji.image_url))
    lastIndex = start + m[0].length
  }
  if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)))
  return frag
}

interface DomPosition {
  node: Node
  offset: number
}

function indexOfChild(node: Node): number {
  let i = 0
  let sibling = node.previousSibling
  while (sibling) {
    i++
    sibling = sibling.previousSibling
  }
  return i
}

/** プレーンテキストオフセット→DOM位置。原子絵文字imgの「内部」は決して返さず、常に手前/直後の
 * ノード境界へ丸める（Text.splitTextは呼ばない。Range.deleteContents/insertNodeが境界点の
 * 分割を仕様上正しく行うため、ここでは正しい{node,offset}のペアを返すことだけに専念する）。 */
function resolveOffset(root: HTMLElement, targetOffset: number): DomPosition {
  let remaining = targetOffset
  let lastPosition: DomPosition = { node: root, offset: 0 }

  const walk = (node: Node): DomPosition | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = (node as Text).data.length
      if (remaining <= len) return { node, offset: remaining }
      remaining -= len
      lastPosition = { node, offset: len }
      return null
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null
    if (isEmojiNode(node)) {
      const len = (node.getAttribute(EMOJI_ATTR) as string).length + 2 // ":name:"
      const parent = node.parentNode as Node
      const idx = indexOfChild(node)
      if (remaining < len) {
        // 内部を指すオフセットは常に手前の境界へクランプする（原子ノードなので「内部」は無い）
        return { node: parent, offset: idx }
      }
      remaining -= len
      lastPosition = { node: parent, offset: idx + 1 }
      return null
    }
    for (const child of Array.from(node.childNodes)) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }

  const found = walk(root)
  return found ?? lastPosition
}

/** DOM位置（Selection/Rangeの境界点）→プレーンテキストオフセット。resolveOffsetの逆写像。 */
function domPositionToOffset(root: HTMLElement, node: Node, nodeOffset: number): number {
  let total = 0
  let found = -1

  const lengthOf = (n: Node): number => {
    if (n.nodeType === Node.TEXT_NODE) return (n as Text).data.length
    if (n.nodeType !== Node.ELEMENT_NODE) return 0
    if (isEmojiNode(n)) return (n.getAttribute(EMOJI_ATTR) as string).length + 2
    if ((n as Element).tagName === 'BR') return 1
    let sum = 0
    for (const child of Array.from(n.childNodes)) sum += lengthOf(child)
    return sum
  }

  const walk = (n: Node): boolean => {
    if (n === node) {
      if (n.nodeType === Node.TEXT_NODE) {
        total += nodeOffset
      } else {
        const children = Array.from(n.childNodes)
        for (let i = 0; i < nodeOffset && i < children.length; i++) total += lengthOf(children[i])
      }
      found = total
      return true
    }
    if (n.nodeType === Node.TEXT_NODE) {
      total += (n as Text).data.length
      return false
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return false
    if (isEmojiNode(n)) {
      total += (n.getAttribute(EMOJI_ATTR) as string).length + 2
      return false
    }
    if ((n as Element).tagName === 'BR') {
      total += 1
      return false
    }
    for (const child of Array.from(n.childNodes)) {
      if (walk(child)) return true
    }
    return false
  }

  walk(root)
  return found === -1 ? total : found
}

/** 現在の選択範囲をプレーンテキストオフセットのペアとして取得する。rootの外に選択がある場合はnull。 */
export function getSelectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const a = domPositionToOffset(root, range.startContainer, range.startOffset)
  const b = domPositionToOffset(root, range.endContainer, range.endOffset)
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

/** プレーンテキストオフセットのペアから選択範囲を設定する。 */
export function setSelectionOffsets(root: HTMLElement, start: number, end: number = start) {
  const total = domToPlainText(root).length
  const lo = Math.max(0, Math.min(Math.min(start, end), total))
  const hi = Math.max(0, Math.min(Math.max(start, end), total))
  const startPos = resolveOffset(root, lo)
  const endPos = resolveOffset(root, hi)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  const sel = window.getSelection()
  if (!sel) return
  sel.removeAllRanges()
  sel.addRange(range)
}

/** [start,end)の範囲を削除し、その場に挿入するための「削除後の（挿入前提の）Range」を返す。
 * 呼び出し元はこのRangeへ直接insertNodeし、そのあとroot.normalize()→setSelectionOffsetsで
 * オフセットベースに選択を再構築すること（normalize()の前後でRangeオブジェクトを跨いで
 * 保持しないというPlanサブエージェントの指摘どおりの手順を徹底するため、offsetも一緒に返す）。 */
function deleteRangeReturningCollapsed(root: HTMLElement, start: number, end: number): { range: Range; offset: number } {
  const total = domToPlainText(root).length
  const lo = Math.max(0, Math.min(Math.min(start, end), total))
  const hi = Math.max(0, Math.min(Math.max(start, end), total))
  const startPos = resolveOffset(root, lo)
  const endPos = resolveOffset(root, hi)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  range.deleteContents()
  return { range, offset: lo }
}

/** [start,end)をプレーンテキストで置き換える（絵文字ショートコード解釈はしない）。挿入後の
 * カーソル位置（挿入したテキストの直後）をオフセットで返す。 */
export function replaceRangeWithText(root: HTMLElement, start: number, end: number, text: string): number {
  const { range, offset } = deleteRangeReturningCollapsed(root, start, end)
  if (text) range.insertNode(document.createTextNode(text))
  root.normalize()
  const result = offset + text.length
  setSelectionOffsets(root, result)
  return result
}

/** [start,end)をメンションハイライト付きで置き換える。span直後には呼び出し元が別途プレーン
 * テキストを続けて挿入し、以後の手打ちがspanの中へ吸い込まれないようにすること（境界の
 * ケアはComposer.tsx側のselectCandidateで行う）。 */
export function replaceRangeWithMentionSpan(
  root: HTMLElement,
  start: number,
  end: number,
  displayText: string,
): { offset: number; span: HTMLSpanElement } {
  const { range, offset } = deleteRangeReturningCollapsed(root, start, end)
  const span = createMentionSpan(displayText)
  range.insertNode(span)
  root.normalize()
  const result = offset + displayText.length
  setSelectionOffsets(root, result)
  return { offset: result, span }
}

/** ノードの直後（＝その要素の外側）へプレーンテキストを挿入し、その直後へカーソルを置く。
 * バグ修正（実機Playwright検証で発見）: replaceRangeWithMentionSpanが返すoffset（＝span末尾の
 * 位置）に対してreplaceRangeWithTextで単純に後続テキストを挿入しようとすると、resolveOffsetが
 * 「spanの中の末尾」という位置をそのまま返し、Range.insertNodeがspanの子としてテキストを挿入して
 * しまう（=spanの外ではなく中に入ってしまう）ことが判明した。この関数はspan要素そのものへの
 * 参照を使い、DOM操作でspanの兄弟として明示的に外側へ挿入することでこれを回避する
 * （メンション挿入直後の空白・以後の手打ちがspanへ誤って吸い込まれるのを防ぐ目的）。 */
export function insertTextAfterNode(node: Node, text: string): void {
  const parent = node.parentNode
  if (!parent) return
  const textNode = document.createTextNode(text)
  parent.insertBefore(textNode, node.nextSibling)
  const range = document.createRange()
  range.setStart(textNode, textNode.length)
  range.collapse(true)
  const sel = window.getSelection()
  if (!sel) return
  sel.removeAllRanges()
  sel.addRange(range)
}

/** [start,end)を原子絵文字ノードで置き換える。ライブショートコード変換・絵文字ピッカー選択の
 * 両方から使う低レベル関数。 */
export function insertEmojiAtRange(root: HTMLElement, start: number, end: number, name: string, imageUrl: string): number {
  const { range, offset } = deleteRangeReturningCollapsed(root, start, end)
  range.insertNode(createEmojiNode(name, imageUrl))
  root.normalize()
  const result = offset + name.length + 2
  setSelectionOffsets(root, result)
  return result
}

/** 現在のカーソル位置（選択があれば置き換え）へ原子絵文字ノードを挿入する便利関数。 */
export function insertAtomicEmojiAtCursor(root: HTMLElement, name: string, imageUrl: string): number {
  const offs = getSelectionOffsets(root)
  const total = domToPlainText(root).length
  const start = offs?.start ?? total
  const end = offs?.end ?? start
  return insertEmojiAtRange(root, start, end, name, imageUrl)
}

/** カーソル直前で完成した`:name:`ショートコードを検出し、customEmojiに解決できれば原子ノードへ
 * 置き換える。ネイティブ入力（`input`イベント）から呼ぶ想定で、IME合成中は呼ばないこと
 * （呼び出し元のComposer.tsxがisComposingで既にガードする）。何も変換しなければfalseを返す。 */
export function tryConvertJustCompletedShortcode(root: HTMLElement, customEmoji: CustomEmoji[]): boolean {
  const offs = getSelectionOffsets(root)
  if (!offs || offs.start !== offs.end) return false
  const cursor = offs.start
  const text = domToPlainText(root)
  // ショートコードは最大24文字＋コロン2つのため、直前26文字程度だけ見れば十分（全文走査を避ける）
  const windowStart = Math.max(0, cursor - 26)
  const m = /:([a-zA-Z0-9_+-]{2,24}):$/.exec(text.slice(windowStart, cursor))
  if (!m) return false
  const emoji = customEmoji.find((e) => e.name.toLowerCase() === m[1].toLowerCase())
  if (!emoji) return false
  const matchStart = cursor - m[0].length
  insertEmojiAtRange(root, matchStart, cursor, m[1], emoji.image_url)
  return true
}

/** 4000文字上限の適用。超過分はカーソル直前（＝直近に入力・貼り付けされた分）から後ろ向きに
 * 切り詰める。IME合成中には呼ばないこと（呼び出し元でガードする）。 */
export function enforceMaxLength(root: HTMLElement, max: number): void {
  const text = domToPlainText(root)
  if (text.length <= max) return
  const cursor = getSelectionOffsets(root)?.start ?? text.length
  const overflow = text.length - max
  const cutStart = Math.max(0, cursor - overflow)
  replaceRangeWithText(root, cutStart, cursor, '')
}

/** 空のcontentEditableへフォーカスするとChromeが単独の<br>を自動挿入することがある既知の挙動への
 * 対処（プレースホルダのCSS `:empty::before` が確実に効くよう、論理的に空のときはDOMも
 * 本当に空にする）。 */
export function removeStrayEmptyBr(root: HTMLElement): void {
  if (root.childNodes.length === 1 && root.firstChild?.nodeName === 'BR') {
    root.removeChild(root.firstChild)
  }
}

/** Undo/Redo後のDOM不変条件の軽量な検査・修復パス（全文再スキャンではなく1回のDOM走査のみ）。
 * ネイティブのUndoスタックは、この投稿欄が原子ノード・メンションspanへ課している制約
 * （絵文字imgは常にcontenteditable=false等）を必ずしも忠実に復元する保証が無いため、
 * historyUndo/historyRedoのinputTypeを受け取ったときにだけComposer.tsx側から呼ぶ。 */
export function normalizeInvariants(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  const emptyTextNodes: Text[] = []
  let node: Node | null = walker.currentNode === root ? walker.nextNode() : walker.currentNode
  while (node) {
    if (node.nodeType === Node.TEXT_NODE && (node as Text).data === '') {
      emptyTextNodes.push(node as Text)
    } else if (isEmojiNode(node)) {
      node.contentEditable = 'false'
    }
    node = walker.nextNode()
  }
  for (const t of emptyTextNodes) t.remove()
  removeStrayEmptyBr(root)
  root.normalize()
}
