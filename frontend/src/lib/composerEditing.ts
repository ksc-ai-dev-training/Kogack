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

// バグ修正（ユーザーからの報告「Enterを押して11行目以降になると、改行するとカーソルがいる行が
// 画面に見えなくなる」を調査中に発見）: 本文の末尾がテキストノード内の孤立した"\n"で終わる
// （＝Enterキーで新しい行を作った直後、まだ何も入力していない状態）とき、そのすぐ後ろに何の
// 実体も無いと、ブラウザはその位置のRange.getClientRects()を空の矩形として返す（実機で
// {top:0,left:0,width:0,height:0}を確認済み）。これにより2つの不具合が同時に起きる:
// (1) 次に入力した文字が期待した新しい行ではなく直前の行の末尾に挿入されてしまう（実機で
// "a"+Enter+"b"の入力が"ab\n"になってしまうことを確認済み。何行も改行を続けるとEnterのたびに
// 交互に発生し、結果的に「1行増えるたびにスクロールしないとカーソルが見えない」という
// 報告そのものの原因にもなっていた——空の矩形のためスクロール追従の基準座標も計算できない）。
// 空のspan要素等、幅を持たない要素を後ろに置くだけでは同じく空の矩形のままで効果が無いことを
// 実機検証で確認済みで、実際に計測対象となる「見えない1文字」（U+200B ゼロ幅スペース）を
// 置いて初めてブラウザが実在の行として認識することを確認した（詳細はensureTrailingNewlineCaretMarker
// 参照）。このマーカーは本文の一部として扱わない：domToPlainTextの戻り値・保存される下書き・
// 送信されるメッセージ本文のいずれにも含まれない（下記CARET_MARKERの用途を参照）。
// MessageList.tsxのEMOJI_ZWJ/EMOJI_VARIATION_SELECTORと同じくString.fromCharCodeで生成する
// （ソースコード上に実際の見えない文字を直接埋め込むと、エディタ・diff上で気づかれにくく
// 事故のもとになるため）
const CARET_MARKER = String.fromCharCode(0x200b) // ゼロ幅スペース（U+200B）

function stripCaretMarker(text: string): string {
  return text.includes(CARET_MARKER) ? text.split(CARET_MARKER).join('') : text
}

/** 本文の末尾が改行で終わっている場合にのみ、その直後へCARET_MARKERを1文字追加する
 * （既存のマーカーは先に取り除いてから再判定するため、複数回呼んでも安全＝冪等）。
 * Composer.tsxのEnterキー処理（通常の改行のみ。「\n- 」で始まる箇条書き継続は末尾に実在の
 * 文字列が続くためこの問題自体が起きず対象外）から、\n挿入の直後に呼ぶ。 */
export function ensureTrailingNewlineCaretMarker(root: HTMLElement): void {
  removeCaretMarkerFromDom(root)
  const last = root.lastChild
  if (last && last.nodeType === Node.TEXT_NODE && (last as Text).data.endsWith('\n')) {
    ;(last as Text).data += CARET_MARKER
  }
}

/** CARET_MARKERをDOMから取り除く（位置を問わず全テキストノードから）。ネイティブな入力
 * イベントのたびに呼び、前回のEnterで置いたマーカーが不要になった時点（＝実際に次の文字が
 * 入力された時点）で速やかに片付ける。
 *
 * バグ修正（実機Playwright検証で発見）: 当初はText.dataへ直接代入するだけの実装だったが、
 * 現在の選択範囲（キャレット）がまさにそのテキストノードを指している状態でText.dataへ
 * 直接代入すると、ブラウザがそのSelectionのanchorOffset/focusOffsetを0へリセットしてしまう
 * ことを実機で確認した（Range.deleteContents()等のRange APIを介さない生のdata書き換えは、
 * 生きたSelectionの境界点を安全に追従調整しない）。これにより「aを入力→Enter→bを入力→
 * 再びEnter」を連続で行うと、2回目のEnterが正しい位置（"a\nb"の末尾）ではなく本文の先頭に
 * 改行を挿入してしまう不具合が実際に発生した。対処として、削除の前後で選択範囲を
 * 自前のオフセットベースAPI（getSelectionOffsets/setSelectionOffsets）で明示的に保存・
 * 復元する（マーカーが実際に含まれる場合のみ、かつrootの外に選択が無い場合のみ）。 */
export function removeCaretMarkerFromDom(root: HTMLElement): void {
  if (!root.textContent || !root.textContent.includes(CARET_MARKER)) return
  const preserved = getSelectionOffsets(root)
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text
      if (t.data.includes(CARET_MARKER)) t.data = stripCaretMarker(t.data)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    for (const child of Array.from(node.childNodes)) walk(child)
  }
  for (const child of Array.from(root.childNodes)) walk(child)
  if (preserved) setSelectionOffsets(root, preserved.start, preserved.end)
}

/** シリアライズ: DOM→プレーンテキスト。テキストノードはそのまま、原子絵文字imgは`:name:`へ、
 * メンションspanは中身のテキストをそのまま透過する（spanは装飾のみで実体はプレーンテキストの
 * ため、activeMentionsInの`text.includes(...)`判定は従来どおりこの出力に対して機能する）。
 * 想定外の<br>が紛れ込んだ場合（外部リッチ貼り付けの取りこぼし等への保険）も改行として扱う。
 * CARET_MARKER（上記）はどの位置にあっても出力から除外する（利用者が実際に入力した文字では
 * ないため、送信・下書き保存・文字数カウントのいずれにも含めない）。 */
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
  return stripCaretMarker(text)
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

/** カーソル（現在の選択範囲の先頭）が入力欄の可視領域内に収まるよう、必要な分だけ
 * el.scrollTopを調整する（textareaがブラウザ標準で行っていた「キャレット追従スクロール」を
 * contentEditableで自前実装したもの）。バグ修正（ユーザーからの報告「Enterを押して11行目
 * 以降になると、改行するたびに下の行が見えなくなりスクロールが必要」）: MAX_ROWS超過後は
 * el自体がoverflow-y:autoでスクロール可能になるが、単に高さを再計算するだけでは新しく
 * 増えた行がスクロール範囲の外に隠れたままになる。選択範囲がel内に無い、またはキャレットの
 * 矩形が計測できない（CARET_MARKER導入前は末尾の孤立した改行で空の矩形になっていた既知の
 * 不具合、上記参照）場合は何もしない。 */
export function scrollCaretIntoView(el: HTMLElement): void {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer)) return
  const caretRange = range.cloneRange()
  caretRange.collapse(true)
  const rect = caretRange.getClientRects()[0]
  if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0)) return
  const elRect = el.getBoundingClientRect()
  if (rect.bottom > elRect.bottom) {
    el.scrollTop += rect.bottom - elRect.bottom
  } else if (rect.top < elRect.top) {
    el.scrollTop -= elRect.top - rect.top
  }
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

// 書式のライブプレビュー（ユーザーからの明示的な要望「太字とか下線とかに変更する機能があるが、
// メッセージ送信後だけでなく、入力している段階でどのような見た目になるのか見られるようにしたい」）。
// 2026-09-10の書式ツールバー実装時点では「入力のたびにスタイル付きノードをDOMツリー全体で
// 差分再構築する処理は自前contentEditable実装で最もバグりやすい」という理由でスコープ外に
// していた（Composer.tsx冒頭のメンションに関する同種の判断と同じ理由）が、書式プレビューは
// メンションと異なり「本文中の任意の位置に既に存在する記法パターンを検出する」性質そのものが
// 本質的に全文スキャンを要する問題であるため、差分更新ではなく「常に全体を作り直す」設計にして
// リスクを抑えた: 呼ばれるたびに(1)自分が過去に挿入した書式ラッパー要素だけを全て解除して
// プレーンな状態に戻し（原子絵文字img・メンションspanはノードごと移動するだけで再生成しない）、
// (2) MessageList.tsx（送信後の表示）と全く同じ正規表現・優先度（コード＞太字/斜体/下線/取消線）で
// 完成した記法パターンだけを検出し、(3) 該当範囲をRange.extractContents()で抽出→スタイル付き
// 要素で包んで戻す。マーカー文字（**・_・++・~~）はテキストとして残したまま範囲全体を
// スタイルする（Slackのように確定後だけマーカーを消す方式は、隠す/戻すためのオフセット管理が
// 追加で必要になり複雑さ・リスクが増すため見送った、シンプルな設計判断）。@メンション・URL
// 自動リンク・名前付きリンクは対象外のまま（メンションは既存の「挿入時点のみハイライト」方式を
// 維持し継続的な全文再スキャンをしない設計を崩さない。リンクは専用ポップアップで確定前に
// テキスト/URLが見えるため「入力中にどう見えるか分からない」という今回の要望の対象外と判断）。
// 箇条書き（行頭「- 」）も対象外（行頭に「- 」という記法自体が既に見た目として自己説明的であり、
// スタイル変化の予測が必要な太字・斜体・下線・取消線・コードとは性質が異なるため）。
//
// unwrap→rewrapは文字の追加・削除を一切行わない（ラッパー要素の付け外しのみ）ため、
// domToPlainText(root)が返すプレーンテキストの長さ・内容は一切変化しない。したがって
// getSelectionOffsets/setSelectionOffsetsが使う「プレーンテキストオフセット」は
// unwrap前後で同じ意味を保ち続け、呼び出し前に保存したオフセットをそのまま呼び出し後に
// 復元するだけでカーソル位置を正しく保てる（新しいオフセット変換ロジックを発明する必要が無い）。

const LIVE_FORMAT_ATTR = 'data-live-format'

// MessageList.tsxのCODE_BLOCK_REGEX/INLINE_CODE_REGEX/BOLD_REGEX/ITALIC_REGEX/UNDERLINE_REGEX/
// STRIKE_REGEXと全く同じ定義（送信後の見た目と入力中のプレビューを一致させるため）
const LIVE_CODE_BLOCK_REGEX = /```([\s\S]*?)```/g
const LIVE_INLINE_CODE_REGEX = /`([^`\n]+)`/g
const LIVE_BOLD_REGEX = /\*\*([\s\S]+?)\*\*/g
const LIVE_STRIKE_REGEX = /~~([\s\S]+?)~~/g
const LIVE_ITALIC_REGEX = /_([\s\S]+?)_/g
const LIVE_UNDERLINE_REGEX = /\+\+([\s\S]+?)\+\+/g

interface LiveFormatCandidate {
  start: number
  end: number
  priority: number
  tagName: string
  kind: string
  className: string
}

const CODE_CLASSNAME = 'rounded border border-line bg-surface-muted px-1 py-0.5 font-mono text-[12.5px] text-code-text'

/** MessageList.tsxのrenderInlineSegmentと同じ優先度付き重なり解決（コード＞太字/斜体/下線/取消線）。
 * 送信後の表示と異なりメンション・URL・名前付きリンクは対象外（上記コメント参照）。 */
function collectLiveFormatCandidates(text: string): LiveFormatCandidate[] {
  const candidates: LiveFormatCandidate[] = []
  for (const m of text.matchAll(LIVE_CODE_BLOCK_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 0, tagName: 'code', kind: 'code-block', className: CODE_CLASSNAME })
  }
  for (const m of text.matchAll(LIVE_INLINE_CODE_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 0, tagName: 'code', kind: 'code', className: CODE_CLASSNAME })
  }
  for (const m of text.matchAll(LIVE_BOLD_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 1, tagName: 'strong', kind: 'bold', className: 'font-bold' })
  }
  for (const m of text.matchAll(LIVE_ITALIC_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 1, tagName: 'em', kind: 'italic', className: 'italic' })
  }
  for (const m of text.matchAll(LIVE_UNDERLINE_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 1, tagName: 'u', kind: 'underline', className: 'underline' })
  }
  for (const m of text.matchAll(LIVE_STRIKE_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 1, tagName: 's', kind: 'strike', className: 'line-through' })
  }
  candidates.sort((a, b) => a.priority - b.priority || a.start - b.start)
  const accepted: LiveFormatCandidate[] = []
  for (const c of candidates) {
    if (accepted.some((a) => c.start < a.end && a.start < c.end)) continue
    accepted.push(c)
  }
  accepted.sort((a, b) => a.start - b.start)
  return accepted
}

/** [start,end)をタグ名・クラスで包む（deleteRangeReturningCollapsedと異なり中身は破棄せず
 * Range.extractContents()で保持したまま新しい親要素へ移す。原子絵文字img・メンションspanが
 * 範囲内にあっても、ノードとして移動するだけで再生成しないため既存の属性・イベント紐付けは
 * 保たれる）。 */
function wrapRangeInElement(root: HTMLElement, start: number, end: number, tagName: string, className: string, kind: string): void {
  if (start >= end) return
  const startPos = resolveOffset(root, start)
  const endPos = resolveOffset(root, end)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  const fragment = range.extractContents()
  const wrapper = document.createElement(tagName)
  wrapper.setAttribute(LIVE_FORMAT_ATTR, kind)
  wrapper.className = className
  wrapper.appendChild(fragment)
  range.insertNode(wrapper)
}

/** 過去にsyncLiveFormattingが挿入した書式ラッパー要素だけを解除し、中身（テキストノード・
 * 原子絵文字img・メンションspan）をその場に残す（`unwrap`＝親を消して子をその位置へ展開する
 * 標準的なDOM操作。子ノードの中身自体は一切変更しない）。 */
function unwrapLiveFormatting(root: HTMLElement): void {
  const wrappers = root.querySelectorAll(`[${LIVE_FORMAT_ATTR}]`)
  wrappers.forEach((wrapper) => {
    const parent = wrapper.parentNode
    if (!parent) return
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper)
    parent.removeChild(wrapper)
  })
}

/** 書式のライブプレビューを最新化する。ネイティブ入力・IME確定・ツールバー操作・メンション/
 * 絵文字挿入・貼り付け・下書き復元など、本文が変わりうるあらゆる箇所の後に呼ぶ想定
 * （Composer.tsxのrefreshEditorHousekeeping、実質すべての変更経路を1箇所に集約している）。
 * 呼ぶたびに全体を作り直す設計のため冪等（何度呼んでも同じ結果になる）。 */
export function syncLiveFormatting(root: HTMLElement): void {
  const preserved = getSelectionOffsets(root)
  unwrapLiveFormatting(root)
  root.normalize()
  const text = domToPlainText(root)
  const matches = collectLiveFormatCandidates(text)
  for (const m of matches) {
    wrapRangeInElement(root, m.start, m.end, m.tagName, m.className, m.kind)
  }
  root.normalize()
  if (preserved) setSelectionOffsets(root, preserved.start, preserved.end)
}
