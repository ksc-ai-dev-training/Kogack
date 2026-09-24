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

/** 書式のライブプレビュー用の隠しマーカーspan（LIVE_FORMAT_MARKER_ATTR、下記参照）かどうかの判定。
 * isEmojiNodeと同じ理由（このspanはcontentEditable=falseで原子的に扱われるため、resolveOffsetも
 * 内部を指すオフセットを返してはいけない）でresolveOffsetから使う。LIVE_FORMAT_MARKER_ATTRは
 * このファイルの後方（書式ライブプレビューのセクション）で定義される定数だが、関数宣言は
 * ホイスティングされ実行（呼び出し）時には既に初期化済みのため問題ない。 */
function isMarkerNode(node: Node): boolean {
  return node.nodeType === Node.ELEMENT_NODE && (node as Element).hasAttribute(LIVE_FORMAT_MARKER_ATTR)
}

/** ノード配下のテキスト総文字数（原子絵文字・BR等の区別はせず、単純にテキストノードの
 * data.lengthを合算するだけの軽量版。隠しマーカーspanの中身は常に短い1〜数個のテキスト
 * ノードのみのため、これで十分）。 */
function textLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length
  if (node.nodeType !== Node.ELEMENT_NODE) return 0
  let sum = 0
  for (const child of Array.from(node.childNodes)) sum += textLength(child)
  return sum
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
 * 分割を仕様上正しく行うため、ここでは正しい{node,offset}のペアを返すことだけに専念する）。
 * rootはエディタ本体（HTMLElement）だけでなく、書式のライブプレビュー（後述）が入れ子処理の
 * 途中で扱う検体DocumentFragmentでもよい（Range APIはどちらに対しても同じように機能するため）。 */
function resolveOffset(root: Node, targetOffset: number): DomPosition {
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
    // バグ修正（実機Playwright検証で発見）: 書式のライブプレビューが入れ子（例: 太字の中の斜体）を
    // 再帰的に処理する際、containerとしてHTMLElementだけでなくDocumentFragment（nodeType=11）も
    // 渡すようになった。ELEMENT_NODE（nodeType=1）だけを許可する判定だとwalk(root)の最初の呼び出し
    // 自体がDocumentFragmentを弾いて即座にnullを返してしまい（子ノードを一切辿らない）、
    // resolveOffsetが常にフォールバック位置{node:root,offset:0}を返す不具合があった。これにより
    // 該当のRangeが常に「先頭で折りたたまれた」状態になり、extractContents()が何も抽出できず、
    // 入れ子になった書式（<em>等）の中身が空のまま、実際の文字は外側にプレーンテキストとして
    // 取り残される（記号も隠れない）という不具合が実機で発生した。DOCUMENT_FRAGMENT_NODEも
    // 子ノードを持つ「親ノード」である点はELEMENT_NODEと同じであるため、ここでも通す。
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return null
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
    // バグ修正（ユーザーからの報告「太字入力されたものをDeleteキーで消すと記号の一部が見えて
    // しまう」の対策でマーカーspanにcontentEditable=falseを付けた際に実機で新たに発覚）:
    // マーカーspanもisEmojiNodeと全く同じ理由でここで原子ノードとして扱う必要がある。
    // 対策前は「remaining<=len」なら迷わずspan内部のテキストノードへ位置を返していたが、
    // ちょうどマーカーの末尾（=次のノードとの境界）を指すオフセットの場合、内部の最後の
    // 文字位置（例: 2文字のマーカーのoffset=2）をそのまま返してしまい、
    // 「contentEditable=falseな要素の内部」という、ブラウザのSelectionが事実上使えない
    // （キャレットを置いても以後のBackspace/Delete等のキー入力を一切受け付けなくなる）
    // 位置になっていた。isEmojiNodeと同じ「remaining<len なら手前の境界へクランプ、
    // それ以外（ちょうど末尾も含む）は消費してnullを返し次のノードへ進む」規則にすることで、
    // マーカーの内部に位置が落ちることを無くした。
    if (isMarkerNode(node)) {
      const len = textLength(node)
      const parent = node.parentNode as Node
      const idx = indexOfChild(node)
      if (remaining < len) {
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

// 書式のライブプレビュー（太字・斜体・下線・取り消し線）。ユーザーからの明示的な要望「入力して
// いる段階で送信した後の表示と同じようにしたい。記号で囲むような表示をなくしたい」を受け、
// 2026-09-10（ツールバー実装）・2026-09-18（マーカー文字を残したまま範囲全体をスタイルするだけの
// 初回ライブプレビュー）に続く見直し。今回はマーカー文字（**・_・++・~~）を常に完全に隠す
// （送信後の実際の見た目と一致させる）方式に一本化した——それ以前に検討した「カーソルが触れて
// いるときだけマーカーを表示する」Typora風の設計は、ユーザーが今回求めているのはボタンによる
// 明示的なモード切替であり、マーカーを手で見て編集する前提そのものが不要になるため、あえて
// 採用しなかった。マーカー文字はdomToPlainTextとの往復性を保つため実際のテキストとして残すが、
// 常にfont-size:1px相当の極小サイズにして視覚的に消す（display:noneにすると幅0の要素になり
// Range.getClientRects()が空の矩形を返しキャレット配置に使えなくなる、というensureTrailing
// NewlineCaretMarkerの教訓と同じ理由で避けた）。
//
// 太字/斜体/下線/取り消し線は入れ子になりうる（下記toggleFormatAtCursorが「太字の中に斜体」の
// ような組み合わせを作れるため）。MessageList.tsx（送信後の表示）は入れ子に対応しない簡易実装の
// ままだが、投稿欄のライブプレビューだけは入れ子を再帰的に解決する（applyNestedFormats）。
// コードブロック・インラインコードはマーカー隠しの対象外（フェンス自体が複数行にまたがる・
// 中身をさらに解釈しないという既存の性質のため、マーカーを含めた範囲全体をそのままスタイル
// する）。@メンション・URL自動リンク・名前付きリンク・箇条書き（行頭「- 」）は対象外のまま
// （メンションは挿入時点のみハイライトする既存方式を維持、リンクは専用ポップアップで確定前に
// 見えるため対象外、箇条書きは記法自体が既に見た目として自己説明的なため）。
//
// 引用（行頭「> 」）はユーザーからの追加要望「>を入力した時点で、送った後に出てくる灰色の線
// みたいなものを表示させるようにしたい」を受けて対象に含めた（下記collectQuoteRanges/
// wrapQuoteRange）。行単位のブロック構造という点で他の（文字位置ベースの）書式とは性質が
// 異なるため、syncLiveFormatting内で別立てのパスとして処理する。
//
// ユーザーからの追加要望「太字、斜体、下線、取り消し線に関しては、ボタンが押されている間はその
// 記法になり、もう一度ボタンを押すと解除される、というような仕組みにしてほしい（Wordみたいな
// 感じ）」を受け、書式トグルボタン（Composer.tsxのtoggleFormatButton）は選択範囲が無い場合、
// その場で（内容が空のまま）開始・終了マーカーを即座に挿入し、カーソルをその間に置く。以後の
// 通常の入力はブラウザのネイティブな「カーソル位置への文字挿入」がその2つのマーカーの間へ
// 自然に入っていくだけで済むため、「まだ確定していない書式領域」を別途追跡する必要が無い
// （普通にMarkdownを手打ちするのと全く同じ仕組みで、Enter・メンション挿入・絵文字挿入・
// 箇条書き/引用トグル等どんな変更経路を通っても自動的に機能する）。複数の書式を組み合わせる
// 場合は内側へ入れ子にし、1つだけ解除する場合、それが最も内側（最後に有効化したもの）なら
// カーソルをその終端マーカーの直後へ移すだけでよい。内側でない書式を解除する場合は、既存の
// 終端マーカー列全体の直後までカーソルを進めて（＝そこまでの内容を正しく閉じて）から、残りの
// 書式だけの新しい空マーカー対を改めて挿入し直す（詳細はtoggleFormatAtCursor参照）。
//
// ボタンの押下状態（activeFormats、Composer.tsx側のReact state）はカーソル位置に対する見た目
// 上のヒントに過ぎず、テキスト自体は常にその場で完全なMarkdownとして存在する（保留中の
// 未確定状態は無い）ため、送信・下書き保存等の前に特別な「確定」処理を挟む必要が無い。
// selectionchangeでカーソルが現在のactiveFormatsの終端マーカー列の直前から外れたことを
// 検知したら、ボタンの見た目だけを元に戻す（isCursorInsideActiveFormats、テキストは
// 一切変更しない）。

const LIVE_FORMAT_ATTR = 'data-live-format'
const LIVE_FORMAT_MARKER_ATTR = 'data-live-format-marker'
const CODE_CLASSNAME = 'rounded border border-line bg-surface-muted px-1 py-0.5 font-mono text-[12.5px] text-code-text'
// マーカー文字（**・_・++・~~）を常に視覚的に消すためのクラス。display:noneを避ける理由は上記コメント参照
// （幅0になりRange.getClientRects()が空になってキャレット配置に使えなくなるため）。
// バグ修正（ユーザーからの報告「太字ボタンを押すとよく見えないが小さい記号らしきものが入力される」）:
// font-size:1pxだけでは文字色が地の色のまま極小の実体として描画され、うっすら点のように見えて
// しまっていた。text-transparentで文字色も透明にし、矩形の大きさ（≠0でキャレット計算には使える）
// はそのまま保ちつつ視覚的には完全に消す。
const HIDDEN_MARKER_CLASSNAME = 'text-[1px] leading-none align-baseline select-none text-transparent'

// MessageList.tsxのCODE_BLOCK_REGEX/INLINE_CODE_REGEXと同じ定義（コードは対象外のまま）。
// 太字・斜体・下線・取り消し線は、書式トグルボタンが「まだ何も入力していない空のマーカー対」を
// 挿入した瞬間から隠したいため、MessageList.tsx側（1文字以上を要求する`[\s\S]+?`）とは異なり
// `[\s\S]*?`（0文字以上）で完成パターンとみなす。送信後の実際の解釈（MessageList.tsx）は
// 変更していない。
const LIVE_CODE_BLOCK_REGEX = /```([\s\S]*?)```/g
const LIVE_INLINE_CODE_REGEX = /`([^`\n]+)`/g
const LIVE_BOLD_REGEX = /\*\*([\s\S]*?)\*\*/g
const LIVE_ITALIC_REGEX = /_([\s\S]*?)_/g
const LIVE_UNDERLINE_REGEX = /\+\+([\s\S]*?)\+\+/g
const LIVE_STRIKE_REGEX = /~~([\s\S]*?)~~/g

export type ToggleFormatKind = 'bold' | 'italic' | 'underline' | 'strike'

export const TOGGLE_FORMAT_MARKERS: Record<ToggleFormatKind, { prefix: string; suffix: string }> = {
  bold: { prefix: '**', suffix: '**' },
  italic: { prefix: '_', suffix: '_' },
  underline: { prefix: '++', suffix: '++' },
  strike: { prefix: '~~', suffix: '~~' },
}

const FORMAT_ELEMENT: Record<ToggleFormatKind, { tagName: string; className: string }> = {
  bold: { tagName: 'strong', className: 'font-bold' },
  italic: { tagName: 'em', className: 'italic' },
  underline: { tagName: 'u', className: 'underline' },
  strike: { tagName: 's', className: 'line-through' },
}

interface LiveMatch {
  start: number
  end: number
  priority: number
  kind: 'code' | ToggleFormatKind
}

/** MessageList.tsxのrenderInlineSegmentと同じ優先度付き重なり解決（コード＞太字/斜体/下線/取消線）。 */
function collectLiveMatches(text: string): LiveMatch[] {
  const candidates: LiveMatch[] = []
  for (const m of text.matchAll(LIVE_CODE_BLOCK_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 0, kind: 'code' })
  }
  for (const m of text.matchAll(LIVE_INLINE_CODE_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 0, kind: 'code' })
  }
  for (const m of text.matchAll(LIVE_BOLD_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 1, kind: 'bold' })
  }
  for (const m of text.matchAll(LIVE_ITALIC_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 1, kind: 'italic' })
  }
  for (const m of text.matchAll(LIVE_UNDERLINE_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 1, kind: 'underline' })
  }
  for (const m of text.matchAll(LIVE_STRIKE_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 1, kind: 'strike' })
  }
  candidates.sort((a, b) => a.priority - b.priority || a.start - b.start)
  const accepted: LiveMatch[] = []
  for (const c of candidates) {
    if (accepted.some((a) => c.start < a.end && a.start < c.end)) continue
    accepted.push(c)
  }
  accepted.sort((a, b) => a.start - b.start)
  return accepted
}

/** fragmentの先頭または末尾からcount文字を切り出し、隠しマーカー用のspanへ包んで返す。
 * マッチした記法の境界文字は必ずテキストノードの先頭/末尾に単独である前提で書いており
 * （正規表現の定義上、絵文字の`:name:`・メンションspanの表示名のいずれにもマーカー用の記号は
 * 含まれ得ない）、想定外の構造だった場合はnullを返す（呼び出し側はマーカーを隠さず範囲全体を
 * そのままスタイルするだけにフォールバックする）。
 *
 * バグ修正（ユーザーからの報告「太字入力されたものをDeleteキーで消そうとすると『**ああ*』のように
 * なって記号の一部が見えてしまう」）: マーカー（**・_・++・~~）は「実テキストとして残しつつ
 * font-size:1pxで隠す」設計のため、以前はcontentEditable指定が無く、ブラウザのネイティブな
 * Backspace/Deleteは他の文字と同様に1文字ずつマーカーを食い荒らせてしまっていた（2文字の
 * マーカーの片方だけが消え、残った1文字が可視化される）。原子絵文字ノード（createEmojiNode）と
 * 同じ`contentEditable=false`をこのspanにも付与し、隣接するBackspace/Deleteがマーカー全体を
 * 1回の操作で不可分に削除する（ネイティブに任せるだけで済み、片方だけ消える中途半端な状態が
 * 発生しなくなる）ようにした。この属性はDOMツリー構造・テキスト内容そのものには影響しないため、
 * resolveOffset/domToPlainTextの走査ロジック（spanを通常の子要素として再帰するだけ）は
 * 変更不要（同じ理由でisEmojiNodeのような特別扱いも不要——マーカーspanは常に
 * unwrapLiveFormatting→再構築のサイクルの中でのみ存在し、このoffset計算が走る時点では
 * 既にunwrap済みで実在しない）。 */
function extractHiddenMarker(fragment: DocumentFragment, count: number, fromEnd: boolean): HTMLSpanElement | null {
  if (count === 0) return null
  const target = fromEnd ? fragment.lastChild : fragment.firstChild
  if (!target || target.nodeType !== Node.TEXT_NODE) return null
  const t = target as Text
  if (t.data.length < count) return null
  const cut = fromEnd ? t.data.slice(t.data.length - count) : t.data.slice(0, count)
  t.data = fromEnd ? t.data.slice(0, t.data.length - count) : t.data.slice(count)
  if (t.data === '') fragment.removeChild(t)
  const span = document.createElement('span')
  span.setAttribute(LIVE_FORMAT_MARKER_ATTR, 'true')
  span.className = HIDDEN_MARKER_CLASSNAME
  span.contentEditable = 'false'
  span.appendChild(document.createTextNode(cut))
  return span
}

/** [start,end)を指定した種別で包む。containerはHTMLElement（エディタ本体）・DocumentFragment
 * （入れ子処理中の中間結果）のどちらでもよい（Range APIはどちらに対しても同じように機能する）。
 * 太字/斜体/下線/取り消し線はさらに中身を再帰的に処理し、入れ子になった別の書式（例: 太字の中の
 * 斜体）も同様にマーカーを隠して正しくスタイルする。 */
function wrapLiveMatch(container: Node, match: LiveMatch): void {
  const { start, end, kind } = match
  if (start >= end) return
  const startPos = resolveOffset(container, start)
  const endPos = resolveOffset(container, end)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  const fragment = range.extractContents()

  if (kind === 'code') {
    const wrapper = document.createElement('code')
    wrapper.setAttribute(LIVE_FORMAT_ATTR, kind)
    wrapper.className = CODE_CLASSNAME
    wrapper.appendChild(fragment)
    range.insertNode(wrapper)
    return
  }

  const { prefix, suffix } = TOGGLE_FORMAT_MARKERS[kind]
  const leading = extractHiddenMarker(fragment, prefix.length, false)
  const trailing = leading ? extractHiddenMarker(fragment, suffix.length, true) : null
  const def = FORMAT_ELEMENT[kind]
  const wrapper = document.createElement(def.tagName)
  wrapper.setAttribute(LIVE_FORMAT_ATTR, kind)
  wrapper.className = def.className

  if (!leading || !trailing) {
    // 想定外の構造（切り出し失敗）。マーカーを隠さず範囲全体をそのままスタイルするだけに
    // フォールバックする（見た目は多少崩れても編集不能にはしないための保険）。
    wrapper.appendChild(fragment)
    range.insertNode(wrapper)
    return
  }

  applyNestedFormats(fragment)
  wrapper.appendChild(leading)
  wrapper.appendChild(fragment)
  wrapper.appendChild(trailing)
  range.insertNode(wrapper)
}

/** fragment（既にトップレベルの1マッチぶんとして抽出済みの中身）の中に、さらに別の書式が
 * 入れ子になっていないかを調べ、あれば再帰的にwrapLiveMatchを適用する。要素で包む操作自体は
 * 文字数を変化させないため、複数のネストしたマッチを順番に処理しても後続のオフセットは
 * ずれない。 */
function applyNestedFormats(fragment: DocumentFragment): void {
  const innerText = domToPlainText(fragment)
  if (!innerText) return
  const nested = collectLiveMatches(innerText)
  for (const m of nested) wrapLiveMatch(fragment, m)
}

/** 過去にsyncLiveFormattingが挿入した書式ラッパー要素・隠しマーカー用spanを解除し、中身
 * （テキストノード・原子絵文字img・メンションspan）をその場に残す。 */
function unwrapLiveFormatting(root: HTMLElement): void {
  const wrappers = root.querySelectorAll(`[${LIVE_FORMAT_ATTR}], [${LIVE_FORMAT_MARKER_ATTR}]`)
  wrappers.forEach((wrapper) => {
    const parent = wrapper.parentNode
    if (!parent) return
    while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper)
    parent.removeChild(wrapper)
  })
}

// 引用のライブプレビュー（ユーザーからの明示的な要望「>を入力した時点で、送った後に出てくる
// 灰色の線みたいなものを表示させるようにしたい」）。太字・斜体・下線・取り消し線と異なり、
// 引用は「行頭に閉じマーカーの無いプレフィックス（「> 」）が続く」という行単位のブロック構造
// のため、collectLiveMatches（文字列内の任意位置に対する開始・終了マーカーのペア）とは別に
// 専用の処理を用意する。MessageList.tsxのsplitLineBlocksと同じ考え方（連続する「> 」行を
// 1つの引用ブロックとしてまとめる）で範囲を検出し、その範囲全体をMessageList.tsxの送信後表示と
// 全く同じクラス（QUOTE_BLOCKQUOTE_CLASSNAME）の<blockquote>で包む。各行の「> 」マーカー自体は
// 太字等と同じ「実テキストとして残しつつ隠す」方式にし、マーカーを除いた本文にはさらに
// 太字・斜体等のインライン書式が効くよう再帰的に解決する（引用の中でも装飾が効く、送信後の
// 表示と同じ仕様）。
const QUOTE_BLOCKQUOTE_CLASSNAME = 'my-1 border-l-[3px] border-line-strong py-0.5 pl-2.5 text-ink-muted'
const QUOTE_LINE_REGEX = /^> (.+)$/

interface QuoteRange {
  start: number
  end: number
}

/** 連続する「> 」行を1つの範囲としてまとめて返す（コードブロックの範囲内は対象外——git diff風の
 * 「> 」行がコードブロックの中身に含まれていても引用として誤解釈しないようにするため）。 */
function collectQuoteRanges(text: string, excludeRanges: { start: number; end: number }[]): QuoteRange[] {
  const ranges: QuoteRange[] = []
  let lineStart = 0
  let blockStart: number | null = null
  const closeBlock = (lineEndExclusive: number) => {
    if (blockStart === null) return
    const start = blockStart
    const end = lineEndExclusive
    blockStart = null
    if (!excludeRanges.some((r) => start < r.end && r.start < end)) {
      ranges.push({ start, end })
    }
  }
  for (const line of text.split('\n')) {
    if (QUOTE_LINE_REGEX.test(line)) {
      if (blockStart === null) blockStart = lineStart
    } else {
      closeBlock(lineStart === 0 ? 0 : lineStart - 1)
    }
    lineStart += line.length + 1
  }
  closeBlock(text.length)
  return ranges
}

/** [start,end)を隠しマーカー用spanで包むだけの汎用ヘルパー（wrapLiveMatchのマーカー抽出と
 * 異なり、範囲全体をそのままspanで囲む——引用の「> 」は行の途中ではなく必ず行頭にあり、
 * 抽出の左右非対称を気にする必要が無いため、より単純なこちらで足りる）。extractHiddenMarkerと
 * 同じ理由でcontentEditable=falseを付与し、隣接するBackspace/Deleteが「> 」を1回の操作で
 * 不可分に削除するようにする（片方の文字だけが消えて残りが可視化される事故を防ぐ）。 */
function wrapRangeInHiddenSpan(container: Node, start: number, end: number): void {
  if (start >= end) return
  const startPos = resolveOffset(container, start)
  const endPos = resolveOffset(container, end)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  const fragment = range.extractContents()
  const span = document.createElement('span')
  span.setAttribute(LIVE_FORMAT_MARKER_ATTR, 'true')
  span.className = HIDDEN_MARKER_CLASSNAME
  span.contentEditable = 'false'
  span.appendChild(fragment)
  range.insertNode(span)
}

/** 引用範囲を<blockquote>で包み、各行の「> 」マーカーを隠したうえで、残った本文へさらに
 * 太字等のインライン書式を再帰的に適用する。 */
function wrapQuoteRange(root: HTMLElement, quoteRange: QuoteRange): void {
  const { start, end } = quoteRange
  if (start >= end) return
  const startPos = resolveOffset(root, start)
  const endPos = resolveOffset(root, end)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  const fragment = range.extractContents()

  // fragmentは（collectQuoteRangesの定義上）「> 」で始まる行だけで構成されているはずなので、
  // 各行の先頭2文字の位置を求めて隠す。wrapRangeInHiddenSpanは文字数を変えないため、複数行分の
  // オフセットをまとめて計算してから順に処理しても後続のオフセットはずれない。
  const innerText = domToPlainText(fragment)
  const markerOffsets: number[] = []
  let pos = 0
  for (const line of innerText.split('\n')) {
    markerOffsets.push(pos)
    pos += line.length + 1
  }
  for (const off of markerOffsets) wrapRangeInHiddenSpan(fragment, off, off + 2)

  applyNestedFormats(fragment)

  const wrapper = document.createElement('blockquote')
  wrapper.setAttribute(LIVE_FORMAT_ATTR, 'quote')
  wrapper.className = QUOTE_BLOCKQUOTE_CLASSNAME
  wrapper.appendChild(fragment)
  range.insertNode(wrapper)
}

/** 書式のライブプレビューを最新化する。ネイティブ入力・IME確定・ツールバー操作・メンション/
 * 絵文字挿入・貼り付け・下書き復元など、本文が変わりうるあらゆる箇所の後に呼ぶ想定
 * （Composer.tsxのrefreshEditorHousekeeping、実質すべての変更経路を1箇所に集約している）。
 * 呼ぶたびに全体を作り直す設計のため冪等（何度呼んでも同じ結果になる）。マーカーの表示・
 * 非表示はカーソル位置に依存しない（常に隠す）ため、選択範囲の変化だけでこの関数を
 * 再度呼ぶ必要は無い。 */
export function syncLiveFormatting(root: HTMLElement): void {
  const preserved = getSelectionOffsets(root)
  unwrapLiveFormatting(root)
  root.normalize()
  const text = domToPlainText(root)

  // コードブロックの範囲を先に確保し、引用の判定がコードブロックの中身まで誤って
  // 解釈しないようにする（例: ```の中にgit diff風の「> 」行がある場合）。
  const codeBlockRanges: { start: number; end: number }[] = []
  for (const m of text.matchAll(LIVE_CODE_BLOCK_REGEX)) {
    const start = m.index ?? 0
    codeBlockRanges.push({ start, end: start + m[0].length })
  }

  // 引用（行頭「> 」の連続行）を先に処理する。行単位のブロック構造のため、文字位置ベースの
  // collectLiveMatchesとは別立てで扱う。
  const quoteRanges = collectQuoteRanges(text, codeBlockRanges)
  for (const q of quoteRanges) wrapQuoteRange(root, q)

  // 太字・斜体・下線・取り消し線・コードのインライン装飾を、引用ブロックが既に消費した範囲を
  // 除いた部分に適用する（引用ブロックの内部はwrapQuoteRangeが自分で再帰的に処理済みのため、
  // ここで重複して処理しない）。
  const matches = collectLiveMatches(text).filter(
    (m) => !quoteRanges.some((q) => m.start < q.end && q.start < m.end),
  )
  for (const m of matches) wrapLiveMatch(root, m)

  root.normalize()
  if (preserved) setSelectionOffsets(root, preserved.start, preserved.end)
}

// 書式トグルボタン（太字・斜体・下線・取り消し線、ユーザーからの明示的な要望）。以下は
// DOM操作を伴わない純粋関数で、実際のテキスト書き換え・カーソル移動はComposer.tsx側が
// TextEdit（{start,end,text}、既存のreplaceRangeWithTextへそのまま渡せる形）を順番に
// 適用することで行う。edits配列は常に「高いオフセット→低いオフセット」の順（後の要素ほど
// 前方）に並んでおり、この順で素直にreplaceRangeWithTextを呼べば、先に適用した編集が
// あとから適用する編集のオフセットへ影響しない（既存のwrapSelectionが「終端側を先に、
// 始端側を後に」処理しているのと同じ考え方）。

// closingSequence/openingSequenceをexportしている理由（ユーザーからの報告「太字ボタンを押して
// 何も入力しないまま2回Deleteを押すと画面に**が見えてしまう」）: 何も入力していない空の
// マーカー対（例:「**|**」、|はカーソル）でBackspace/Deleteを押すと、閉じ／開きマーカーの
// どちらか一方（隠しマーカーspanはcontentEditable=falseで原子的に扱われる）だけがネイティブに
// 1回で削除されてしまい、残った側が「対になる相手を失った単独の**」としてunwrapLiveFormatting
// 後の正規表現に一致しなくなり、隠されずそのまま可視の文字列として残ってしまう。この事故を
// Composer.tsx側のhandleKeyDownで「空のactiveFormatsに対するBackspace/Deleteはマーカー対全体を
// 1回の編集でまとめて削除する」形であらかじめ防ぐために、この2関数をエクスポートする。
export function closingSequence(formats: ToggleFormatKind[]): string {
  return formats
    .slice()
    .reverse()
    .map((f) => TOGGLE_FORMAT_MARKERS[f].suffix)
    .join('')
}

export function openingSequence(formats: ToggleFormatKind[]): string {
  return formats.map((f) => TOGGLE_FORMAT_MARKERS[f].prefix).join('')
}

/** カーソル（選択なし）が現在activeFormatsの終端マーカー列の直前に位置しているか
 * （＝ボタンの押下状態がまだ有効かどうか）を判定する。selectionchangeで使う。 */
export function isCursorInsideActiveFormats(text: string, cursor: number, activeFormats: ToggleFormatKind[]): boolean {
  if (activeFormats.length === 0) return false
  const seq = closingSequence(activeFormats)
  return text.slice(cursor, cursor + seq.length) === seq
}

export interface TextEdit {
  start: number
  end: number
  text: string
}

export interface ToggleFormatAtCursorResult {
  /** 高いオフセット→低いオフセットの順（0〜1件）。空配列ならテキストの変更は不要。 */
  edits: TextEdit[]
  cursor: number
  activeFormats: ToggleFormatKind[]
}

/** 選択範囲が無い（カーソルのみ）状態で書式トグルボタンを押した結果を計算する。kindが既に
 * activeFormatsに含まれていなければ有効化、含まれていれば無効化する。 */
export function toggleFormatAtCursor(
  text: string,
  cursor: number,
  activeFormats: ToggleFormatKind[],
  kind: ToggleFormatKind,
): ToggleFormatAtCursorResult {
  const isActive = activeFormats.includes(kind)
  const cursorValid = isCursorInsideActiveFormats(text, cursor, activeFormats)

  if (!isActive) {
    // 有効化: 現在のカーソル位置に新しい書式の開始・終了マーカーを挿入し、間へカーソルを置く。
    // カーソルが既存のactiveFormatsの終端マーカー列の直前に無い（利用者が移動した後など）場合は、
    // 古いactiveFormatsの記憶を信用せず、この書式単体から新しく始める（安全側のフォールバック）。
    const base = cursorValid ? activeFormats : []
    const { prefix, suffix } = TOGGLE_FORMAT_MARKERS[kind]
    return {
      edits: [{ start: cursor, end: cursor, text: prefix + suffix }],
      cursor: cursor + prefix.length,
      activeFormats: [...base, kind],
    }
  }

  if (!cursorValid) {
    // カーソルが既にズレている状態で同じボタンをもう一度押した場合。テキストには一切触れず、
    // 記憶からその書式だけを取り除く（ボタンの見た目を正すだけ）。
    return { edits: [], cursor, activeFormats: activeFormats.filter((f) => f !== kind) }
  }

  const idx = activeFormats.indexOf(kind)
  const isInnermost = idx === activeFormats.length - 1
  const { prefix, suffix } = TOGGLE_FORMAT_MARKERS[kind]

  if (isInnermost) {
    const isEmpty = text.slice(Math.max(0, cursor - prefix.length), cursor) === prefix
    if (isEmpty) {
      // 何も入力しないまま同じボタンをもう一度押して解除した場合は、空のマーカー対を丸ごと
      // 削除する（本文に空の**が残らないようにする）
      return {
        edits: [{ start: cursor - prefix.length, end: cursor + suffix.length, text: '' }],
        cursor: cursor - prefix.length,
        activeFormats: activeFormats.slice(0, -1),
      }
    }
    // 最も内側の書式を解除: 自分自身の終端マーカーの直後までカーソルを進めるだけでよい
    // （残りの書式の終端マーカー列はそのまま後ろに続いている）
    return { edits: [], cursor: cursor + suffix.length, activeFormats: activeFormats.slice(0, -1) }
  }

  // 内側でない書式を解除: 現在有効な全書式の終端マーカー列全体の直後までカーソルを進めて
  // （＝そこまでに入力した内容を正しく閉じて）から、残りの書式だけの新しい空マーカー対を
  // 改めて挿入し直す（続けて入力すると、残りの書式のままタイプできるようにするため）。
  const fullClosing = closingSequence(activeFormats)
  const afterClosing = cursor + fullClosing.length
  const remaining = activeFormats.filter((f) => f !== kind)
  if (remaining.length === 0) {
    return { edits: [], cursor: afterClosing, activeFormats: [] }
  }
  const reopenOpen = openingSequence(remaining)
  const reopenClose = closingSequence(remaining)
  return {
    edits: [{ start: afterClosing, end: afterClosing, text: reopenOpen + reopenClose }],
    cursor: afterClosing + reopenOpen.length,
    activeFormats: remaining,
  }
}

export interface ToggleFormatOnSelectionResult {
  /** 常に2件、高いオフセット→低いオフセットの順。 */
  edits: TextEdit[]
  selectionStart: number
  selectionEnd: number
}

/** 選択範囲がある状態で書式トグルボタンを押した結果を計算する（選択範囲の直前・直後に既に
 * ちょうどそのマーカーが付いていれば外す、無ければ付けるトグル動作）。戻り値の選択範囲は
 * 常にcontent部分（マーカーを除く）を指す。 */
export function toggleFormatOnSelection(
  text: string,
  start: number,
  end: number,
  kind: ToggleFormatKind,
): ToggleFormatOnSelectionResult {
  const { prefix, suffix } = TOGGLE_FORMAT_MARKERS[kind]
  const hasPrefix = text.slice(Math.max(0, start - prefix.length), start) === prefix
  const hasSuffix = text.slice(end, end + suffix.length) === suffix
  if (hasPrefix && hasSuffix) {
    return {
      edits: [
        { start: end, end: end + suffix.length, text: '' },
        { start: start - prefix.length, end: start, text: '' },
      ],
      selectionStart: start - prefix.length,
      selectionEnd: end - prefix.length,
    }
  }
  return {
    edits: [
      { start: end, end, text: suffix },
      { start, end: start, text: prefix },
    ],
    selectionStart: start + prefix.length,
    selectionEnd: end + prefix.length,
  }
}
