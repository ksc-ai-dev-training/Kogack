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

// consumeRawMarkdownSyntax（本ファイル後方の書式セクション参照）が、手打ちの生Markdown記号
// （**等）を実要素へ破壊的に変換する間、選択範囲（カーソル）の位置を追跡するための目印文字。
// CARET_MARKER（U+200B）とは別の文字を使う——Enterキーで置かれた既存のCARET_MARKERが同じ
// タイミング（Enter直後のafterMutate→refreshEditorHousekeeping→syncLiveFormatting→
// consumeRawMarkdownSyntaxという1本の呼び出し経路）で本文中に残っている場合があり、同じ文字を
// 目印に使うと「Enterが置いた本来のマーカー」と「この関数が今回だけ使う目印」を区別できなくなる
// ため。選択が折りたたまれている（カーソルのみ）場合はSELECTION_START_MARKERのみを使う。
const SELECTION_START_MARKER = String.fromCharCode(0x2063) // INVISIBLE SEPARATOR（U+2063）
const SELECTION_END_MARKER = String.fromCharCode(0x2064) // INVISIBLE PLUS（U+2064）

function stripSelectionMarkers(text: string): string {
  if (!text.includes(SELECTION_START_MARKER) && !text.includes(SELECTION_END_MARKER)) return text
  return text.split(SELECTION_START_MARKER).join('').split(SELECTION_END_MARKER).join('')
}

/** rootの一番最後（lastChildを再帰的に辿った先）にあるテキストノードを返す。要素をまたいで
 * 末尾を辿る必要があるのは、引用等のブロック要素（2026-09-25導入）の内側で改行した場合、
 * 本文の実質的な末尾がroot直下ではなく<blockquote>等の内側のテキストノードになるため。 */
function findDeepestLastTextNode(node: Node): Text | null {
  let current: Node | null = node
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) return current as Text
    if (current.nodeType !== Node.ELEMENT_NODE) return null
    current = current.lastChild
  }
  return null
}

/** 本文の末尾（引用等のブロック要素の内側にネストしている場合も含む）が改行で終わっている
 * 場合にのみ、その直後へCARET_MARKERを1文字追加する（既存のマーカーは先に取り除いてから
 * 再判定するため、複数回呼んでも安全＝冪等）。Composer.tsxのEnterキー処理（通常の改行・
 * 引用内の改行。「\n- 」で始まる箇条書き継続は末尾に実在の文字列が続くためこの問題自体が
 * 起きず対象外）から、\n挿入の直後に呼ぶ。
 *
 * バグ修正（Playwrightでの引用のEnter継続検証中に発見）: 以前はroot.lastChildだけを見ていた
 * ため、末尾の"\n"がroot直下のテキストノードではなく<blockquote>の内側にある場合（引用行で
 * Enterを押して続ける場合、常にこの状態になる）に何もせず、この関数がそもそも存在する理由
 * そのものである「末尾の孤立した改行の直後にブラウザが正しくキャレットを計測できず、次に
 * 入力した文字が新しい行ではなく直前の行の末尾に挿入されてしまう」不具合がそのまま再発して
 * いた。findDeepestLastTextNodeで要素をまたいで実際の末尾テキストノードを見つけるようにした。 */
export function ensureTrailingNewlineCaretMarker(root: HTMLElement): void {
  removeCaretMarkerFromDom(root)
  const last = findDeepestLastTextNode(root)
  if (last && last.data.endsWith('\n')) {
    last.data += CARET_MARKER
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
 * 復元する（マーカーが実際に含まれる場合のみ、かつrootの外に選択が無い場合のみ）。
 *
 * バグ修正（ユーザーからの報告「箇条書きで黒点を消すと不自然な空行ができ、そこに文字を
 * 打って送信すると文字が消える」の調査で判明。3項目以上の箇条書きの真ん中の空項目でEnter→
 * Backspaceする再現手順で実機同様の文字欠落をPlaywrightで確認）: preservedはマーカーを
 * まだ含んだ状態のオフセット（マーカーの1文字ぶんを数えた値）である一方、この関数はその直後に
 * マーカー自身を取り除いて全体を1文字短くする。マーカーより後ろの位置を指していたpreservedの
 * 値をそのまま新しい（1文字短くなった）本文へ setSelectionOffsets すると、実質的に本来の
 * 位置よりも1文字分後ろにカーソルを置いてしまう。取り除かれる直前のマーカーの位置を
 * 覚えておき、preservedがその位置より後ろだった場合だけ1を引いて補正する（マーカーが
 * 本文の末尾にあり、かつ以後に何も続かない場合は、この補正をしなくてもsetSelectionOffsets内の
 * クランプ処理が偶然同じ結果になるため今まで表面化しなかった——マーカーの後ろに実際の文字列が
 * 続く場合にだけ、その先頭の1文字が誤って"消費"され、Backspace等の後続処理がその文字の手前
 * ではなく直後を「項目の先頭」と誤認識し、結果としてネイティブ処理が本来消してはいけない
 * その1文字を削除してしまっていた）。 */
export function removeCaretMarkerFromDom(root: HTMLElement): void {
  if (!root.textContent || !root.textContent.includes(CARET_MARKER)) return
  const preserved = getSelectionOffsets(root)
  const markerOffset = preserved ? findCaretMarkerOffset(root) : -1
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
  if (preserved) {
    const adjust = (v: number) => (markerOffset !== -1 && v > markerOffset ? v - 1 : v)
    setSelectionOffsets(root, adjust(preserved.start), adjust(preserved.end))
  }
}

/** CARET_MARKERを含むテキストノードを探し、マーカー自身の直前（＝マーカーが無くなった後の
 * 本文で、それが占めていた1文字ぶんの境界）の絶対オフセットを返す。見つからなければ-1。
 * removeCaretMarkerFromDomの位置補正専用（マーカーを取り除く前に呼ぶこと）。 */
function findCaretMarkerOffset(root: HTMLElement): number {
  let result = -1
  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const idx = (node as Text).data.indexOf(CARET_MARKER)
      if (idx === -1) return false
      result = domPositionToOffset(root, node, idx)
      return true
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false
    for (const child of Array.from(node.childNodes)) {
      if (walk(child)) return true
    }
    return false
  }
  walk(root)
  return result
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
    // 箇条書き（data-block-format="list"）は1行=1つのdata-block-format="list-item"要素という
    // モデル（本ファイル後方の箇条書きセクション参照）のため、項目の間にだけ仮想的な"\n"を
    // 補う（項目自体はテキストとして実在する"\n"を持たない——行区切りが要素の境界そのもの）。
    if ((node as Element).getAttribute(BLOCK_FORMAT_ATTR) === 'list') {
      const items = Array.from(node.childNodes)
      items.forEach((item, i) => {
        if (i > 0) text += '\n'
        for (const child of Array.from(item.childNodes)) walk(child)
      })
      return
    }
    for (const child of Array.from(node.childNodes)) walk(child)
  }
  for (const child of Array.from(root.childNodes)) walk(child)
  return stripCaretMarker(text)
}

/** シリアライズ: DOM→送信用Markdown文字列。domToPlainTextと同じ走査だが、太字・斜体・下線・
 * 取り消し線を表す実要素（`data-toggle-format`属性、下記参照）に出会ったら、その中身を再帰的に
 * シリアライズしてからMarkdown記号（`**`・`_`・`++`・`~~`）で包む。これらの書式は本文・DOMに
 * マーカー文字を一切持たない実構造（<strong>/<em>/<u>/<s>）として表現されるため（ユーザーからの
 * 要望「押下状態で見た目が切り替わる方式にしたい。記号が裏で入力されるのをやめてほしい」への
 * 対応、詳細は本ファイル後方の書式セクションの冒頭コメント参照）、送信・下書き保存の直前だけ
 * この関数でMarkdown記号を生成する。
 * 中身が空文字の場合は何も出力しない（`****`等の未解釈記号が送信され、受信側でMessageList.tsxの
 * 正規表現（1文字以上必須）が一致せず記号がそのまま可視化されてしまうのを防ぐ——中身が空になった
 * ラッパーはremoveEmptyToggleFormatWrappersで随時掃除される想定だが、念のためここでも二重に守る）。
 * 引用（<blockquote data-live-format="quote">）・コード（<code data-live-format="code">）・
 * その中の隠しマーカーspanは非対応要素として素通りし、domToPlainTextと同じく生の"> "/バック
 * ティック文字列がそのまま出力される（この2つは今回の変更の対象外のまま）。 */
export function domToMarkdown(root: Node): string {
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node as Text).data
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    if (isEmojiNode(node)) return `:${node.getAttribute(EMOJI_ATTR)}:`
    if ((node as Element).tagName === 'BR') return '\n'
    // 箇条書き（data-block-format="list"）は各項目（data-block-format="list-item"）を
    // 個別に直列化し、"- "を付けて"\n"で連結する（domToPlainTextと同じ「項目の境界=仮想的な
    // 改行」モデル、本ファイル後方の箇条書きセクション参照）。項目自体の中身は太字等を含みうる
    // ため、genericなwalkでそのまま再帰する。
    if ((node as Element).getAttribute(BLOCK_FORMAT_ATTR) === 'list') {
      return Array.from(node.childNodes)
        .map((item) => `- ${Array.from(item.childNodes).map(walk).join('')}`)
        .join('\n')
    }
    const inner = Array.from(node.childNodes).map(walk).join('')
    const kind = (node as Element).getAttribute(TOGGLE_FORMAT_ELEMENT_ATTR) as ToggleFormatKind | null
    if (kind && inner) {
      const { prefix, suffix } = TOGGLE_FORMAT_MARKERS[kind]
      return prefix + inner + suffix
    }
    // 引用（data-block-format="quote"）はマーカー文字を一切持たない実DOM構造のため、
    // 送信直前にここで各行へ「> 」を復元する（wrapQuoteRangeのコメント参照）。
    const blockKind = (node as Element).getAttribute(BLOCK_FORMAT_ATTR)
    if (blockKind === 'quote') {
      return inner
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
    }
    // コードブロック（data-block-format="codeblock"）も同様にマーカー文字（``` ）を持たない
    // 実DOM構造のため、送信直前に復元する。前後の"\n"はconsumeCodeBlockMatches側の
    // stripOuterNewlineが投稿欄の表示のために取り除いた分を、ここで必ず復元する
    // （MessageList.tsxのsplitCodeBlocksが受信側で対称に1つだけ取り除く）。
    if (blockKind === 'codeblock') {
      return '```\n' + inner + '\n```'
    }
    return inner
  }
  const children = Array.from(root.childNodes)
  const parts = children.map(walk)
  // バグ修正（ユーザーからの報告「箇条書きで黒点を消すと不自然な空行ができる」）: 箇条書き
  // （data-block-format="list"）の直後に実在する"\n"を置くと、ブロック要素の直後でwhite-space:
  // pre-wrapが改行を二重に数えてしまう（詳細はexitEmptyListItemのコメント参照）ため、
  // 箇条書きを抜けた直後のプレーンな行はDOM上に実在の"\n"を持たない（CARET_MARKERのみを
  // 置く）方式に変更した。そのため送信用Markdownを組み立てるここでだけ、箇条書きの直後に
  // 実際の文字列が続く場合に"\n"を1つ補う（DOMに実在の"\n"が既にある場合は二重に足さない
  // ——手打ちの"- "検出等、他の経路で既に区切られているケースまで壊さないため）。
  for (let i = 0; i < parts.length - 1; i++) {
    const child = children[i]
    const isListBlock = child.nodeType === Node.ELEMENT_NODE && (child as Element).getAttribute(BLOCK_FORMAT_ATTR) === 'list'
    if (!isListBlock) continue
    const next = stripCaretMarker(parts[i + 1])
    if (next && !next.startsWith('\n')) parts[i + 1] = '\n' + parts[i + 1]
  }
  const text = parts.join('')
  return stripCaretMarker(stripSelectionMarkers(text))
}

/** バグ修正（ユーザーからの報告「コードブロックを入力するときに、途中で改行した状態で送信すると、
 * コードブロックの表示がなくなる」）: コードブロックは閉じる``` をまだ打っていない（＝
 * findCodeBlockProtectedRanges等が「入力中」として保護している）間はまだ生テキストのままで
 * <pre>へ変換されない（consumeCodeBlockMatchesは開始・終了の対になった```しか変換しない、
 * 前方のコメント参照）。複数行のコードを書いている最中は改行を挟むのが普通の操作であり、
 * 閉じる``` を打つ前にCtrl+Enterで送信してしまうと、本文には対になっていない生の```が
 * そのまま残る。受信側（MessageList.tsxのCODE_BLOCK_REGEX）は開始・終了のペアが揃って
 * いないと一致しないため、コードブロックとして整形されず生の```が可視化されてしまっていた。
 * 送信直前のMarkdown文字列に対して、```の出現数が奇数（＝閉じられていない）なら末尾へ
 * 1つ補って強制的に閉じる。Composer.tsxのsend()からdomToMarkdownの直後に呼ぶ想定
 * （下書き保存にはあえて適用しない——まだ入力を続けるかもしれない下書きの生テキストを
 * 勝手に書き換えると、続きを打ったときの意図しない変換につながるため）。 */
export function closeDanglingCodeFence(text: string): string {
  const fenceCount = (text.match(/```/g) ?? []).length
  return fenceCount % 2 === 1 ? `${text}\n\`\`\`` : text
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
    // 箇条書き（data-block-format="list"）の項目間には、絵文字img・マーカーspanと同じ
    // 「原子的な1文字ぶんの仮想区切り」パターンを適用する（本ファイル後方の箇条書きセクション
    // 参照）。項目自体は普通に再帰するだけで良い（textLength/domToPlainTextと矛盾しないよう、
    // 項目と項目の間でだけremainingを1消費する）。
    // バグ修正（実機Playwright検証で発見）: ここまでの分岐はELEMENT_NODEとDOCUMENT_FRAGMENT_NODEの
    // 両方を通す（前方のコメント参照、書式の入れ子処理がcontainerとしてDocumentFragmentも渡す
    // ため）。DocumentFragmentにはgetAttributeが存在しないため、nodeType===ELEMENT_NODEを
    // 確認してから呼ぶ必要がある（確認しないと"node.getAttribute is not a function"で
    // 例外になり、箇条書きボタン等の操作全体が失敗していた）。 */
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).getAttribute(BLOCK_FORMAT_ATTR) === 'list') {
      const items = Array.from(node.childNodes)
      for (let i = 0; i < items.length; i++) {
        const found = walk(items[i])
        if (found) return found
        if (i < items.length - 1) {
          remaining -= 1
          lastPosition = { node, offset: i + 1 }
        }
      }
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
    // 箇条書き（resolveOffsetの同名コメント参照）: 項目間の仮想的な"\n"ぶんを加算する。
    if ((n as Element).getAttribute(BLOCK_FORMAT_ATTR) === 'list') {
      const items = Array.from(n.childNodes)
      return items.reduce((sum, item, i) => sum + (i > 0 ? 1 : 0) + lengthOf(item), 0)
    }
    let sum = 0
    for (const child of Array.from(n.childNodes)) sum += lengthOf(child)
    return sum
  }

  const walk = (n: Node): boolean => {
    if (n === node) {
      if (n.nodeType === Node.TEXT_NODE) {
        total += nodeOffset
      } else if ((n as Element).getAttribute(BLOCK_FORMAT_ATTR) === 'list') {
        // バグ修正（Playwrightでの箇条書きBackspace検証中に発見）: 項目間の区切りを表す仮想的な
        // "\n"1文字ぶんは、消費した項目の数（i>0の項目ごとに+1）ではなく「これから到達する
        // 子要素インデックス（nodeOffset）の手前まで何個の区切りを通過したか」で決まる。例えば
        // 2項目のリストでnodeOffset=1（2項目目の先頭）を求める場合、ループはi=0（1項目目）
        // しか回らずi>0の分岐に一度も入れないため、1項目目と2項目目の間にある区切り自体が
        // 数え落とされ、2項目目の先頭オフセットが実際より1小さく計算されてしまっていた
        // （computeElementOffsetがこの関数を使うため、2項目目以降でのBackspace/Enterの
        // 「カーソルが項目の先頭と一致するか」判定が常にずれて成立しなくなる不具合の原因）。
        // 通過した区切りの数はnodeOffset自体（末尾を指す場合は項目数-1が上限）に等しい。
        const items = Array.from(n.childNodes)
        for (let i = 0; i < nodeOffset && i < items.length; i++) total += lengthOf(items[i])
        if (nodeOffset > 0) total += Math.min(nodeOffset, items.length - 1)
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
    if ((n as Element).getAttribute(BLOCK_FORMAT_ATTR) === 'list') {
      const items = Array.from(n.childNodes)
      for (let i = 0; i < items.length; i++) {
        if (i > 0) total += 1
        if (walk(items[i])) return true
      }
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

// バグ修正（実機Playwright検証で発見。ユーザーからの報告「太字を解除した直後に入力した文字が
// まだ太字のまま」「内側でない書式を解除した直後に入力した文字が古い入れ子構造の中に迷い込む」
// の根本原因）: setSelectionOffsets/deleteRangeReturningCollapsedは範囲クランプの基準として
// domToPlainText(root).lengthを使っていたが、これはCARET_MARKER（改行キャレット問題向けの
// 見えない追跡文字、上記参照）を除外した文字数になる。一方、getSelectionOffsetsが使う
// domPositionToOffset（実DOMを走査してオフセットを求める）はCARET_MARKERを除外せずに数える。
// この不一致のため、toggleFormatAtCursorDom（書式セクション参照）がCARET_MARKERを退出点の
// 目印として要素の直後へ挿入し、そこへ正しくSelectionを置いても、直後に必ず走る
// syncLiveFormattingの選択保存・復元（getSelectionOffsets→setSelectionOffsets）が「マーカーの
// 直後」というオフセットをdomToPlainText(root).length基準で1つ短く切り詰めてしまい、
// マーカーの手前（＝閉じたはずの要素の内側）へ巻き戻ってしまっていた。範囲クランプの基準は
// domPositionToOffsetと同じ数え方（CARET_MARKERを除外しない）で統一する必要がある。 */
function rawDomLength(root: HTMLElement): number {
  return domPositionToOffset(root, root, root.childNodes.length)
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
  const total = rawDomLength(root)
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
  const total = rawDomLength(root)
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

// 書式（太字・斜体・下線・取り消し線）。ユーザーからの要望の変遷:
// 2026-09-10 ツールバー実装 → 2026-09-18 マーカー文字を残したまま範囲全体をスタイルするだけの
// 初回ライブプレビュー → 2026-09-24 マーカー文字を常に完全に隠す方式（送信後の見た目と一致させる）
// → 今回、「押下状態で見た目が切り替わる（送信時と入力時の見た目が同じになるようにする）方式に
// したい」「記法のボタンを押すと一文字分見えない何かが入力されるのをやめてほしい」という要望を
// 受けての全面再設計。
//
// 従来はマーカー文字（**・_・++・~~）を本文の実テキストとして持ち、font-size:1px・
// color:transparentの隠しspanで視覚的に消していた（domToPlainTextとの往復性のため）。この方式は
// 「本文には常にMarkdownが実在し、隠しているだけ」という前提のため、Backspace/Deleteが隠し
// マーカーを対で消せず片方だけ残る、境界位置で記号が可視化される等の不具合を繰り返し生んだ
// （このファイルのgit履歴・過去のバグ修正コメント参照）。
//
// 新方式: 太字・斜体・下線・取り消し線・インラインコードは、マーカー文字を一切持たない実DOM構造
// （<strong>/<em>/<u>/<s>/<code>、TOGGLE_FORMAT_ELEMENT_ATTR="<kind>"）として表現する。引用・
// コードブロックも同じ方針で、マーカー文字を持たない<blockquote>/<pre>（BLOCK_FORMAT_ATTR）として
// 表現する（2026-09-25、「コード・箇条書き・引用にも入力している時点で送信後の表示を反映させたい」
// という要望を受けて太字等から拡張、旧LIVE_FORMAT_ATTR/LIVE_FORMAT_MARKER_ATTRの隠しマーカー方式は
// 全廃した）。Markdown記号は送信・下書き保存の直前にdomToMarkdown（domToPlainTextの直後に定義）が
// DOM構造から生成する。箇条書き（「- 」）だけは複数の行に対して実際の黒丸を出す必要があり構造が
// 異なるため、本ファイル後方の別セクションで扱う。
//
// ボタン押下時のツールバー入力は2段階（Composer.tsx側）:
//  - pendingFormats: ボタンを押しただけ・まだ何も入力していない状態（本文・DOMに一切触れない）。
//  - activeFormats: 実際にマーカー文字を持たない<strong>等の実要素が既に本文に存在する状態。
// 実際に文字が入力された瞬間、Composer.tsxのmaterializePendingFormatsがwrapRangeInFormats
// （下記）でその場に直接ラップし、pendingFormats→activeFormatsへ引き継ぐ。
//
// 手打ちで生Markdown（**word**等）を直接入力した場合も、送信後の見た目と食い違わないよう
// （このMarkdown方言にエスケープ機構が一切無いため、放置すると入力中は記号のまま・送信後は
// 書式が効くというWYSIWYG不一致が起きる）、今までと同様に検出するが、隠すのではなくマーカー
// 文字を削除して実要素へ変換する（consumeRawMarkdownSyntax、破壊的変換）。
//
// 太字/斜体/下線/取り消し線は入れ子になりうる。MessageList.tsx（送信後の表示）と同じ再帰的
// ネスト解決を、DOM構造（toggleFormatAtCursorDom・wrapRangeInFormats）とテキスト検出
// （consumeRawMarkdownSyntax）の両方で行う。

// LIVE_FORMAT_MARKER_ATTR/HIDDEN_MARKER_CLASSNAMEは、下記extractHiddenMarkerが「マーカー文字を
// 削り取る」副作用のためだけに内部的に生成するspanの属性・クラス（返り値のspan自体はどの呼び出し元も
// 実際にDOMへ挿入しない。詳細はextractHiddenMarkerのコメント参照）。かつては引用・コードの
// マーカー文字を隠すために実際にDOMへ挿入されていたが、2026-09-25に太字等と同じ「マーカー文字を
// 一切持たない実DOM構造」方式へ全面移行したため、その用途は無くなった。
const LIVE_FORMAT_MARKER_ATTR = 'data-live-format-marker'
const CODE_CLASSNAME = 'rounded border border-line bg-surface-muted px-1 py-0.5 font-mono text-[12.5px] text-code-text'
// マーカー文字（**・_・++・~~）を常に視覚的に消すためのクラス。display:noneを避ける理由は上記コメント参照
// （幅0になりRange.getClientRects()が空になってキャレット配置に使えなくなるため）。
// バグ修正（ユーザーからの報告「太字ボタンを押すとよく見えないが小さい記号らしきものが入力される」）:
// font-size:1pxだけでは文字色が地の色のまま極小の実体として描画され、うっすら点のように見えて
// しまっていた。text-transparentで文字色も透明にし、矩形の大きさ（≠0でキャレット計算には使える）
// はそのまま保ちつつ視覚的には完全に消す。
// バグ修正（ユーザーからの報告「下線と取り消し線で小さい点みたいな記号が見える」）: 下線・
// 取り消し線は親要素（<u>/<s>）のtext-decoration（下線・打ち消し線）が子のマーカーspanにも
// そのまま貫通して描画される。文字色を透明にしても、極小フォントサイズの上に装飾線だけが
// 乗った状態は小さな点として視認できてしまっていたため、マーカーspan自身にno-underline
// （text-decoration-line:none）を明示し、装飾線がマーカー部分には一切描画されないようにする。
const HIDDEN_MARKER_CLASSNAME = 'text-[1px] leading-none align-baseline select-none text-transparent no-underline'

// MessageList.tsxのCODE_BLOCK_REGEX/INLINE_CODE_REGEXと同じ定義。
const RAW_CODE_BLOCK_REGEX = /```([\s\S]*?)```/g
const INLINE_CODE_REGEX = /`([^`\n]+)`/g
// MessageList.tsxのコードブロック描画（<pre>）と全く同じクラス。ユーザーからの報告
// 「コードブロックを出現させたとき（中に何も文字列がないとき）に、コードブロックが細すぎて
// カーソルが半分しか見えていない」への対処として2つ重ねている——中身が本当に空（子ノードが
// 1つも無い）の<pre>はブラウザ上で行ボックス自体が生成されず、padding分の高さしか残らない
// （実テキストが1文字も無いとキャレット表示だけが浮いて見切れる）。
// (1) empty:before:content-['']: 空のCSS生成コンテンツ（擬似要素、実DOMには一切現れない——
//     箇条書きの行頭マーカーbefore:content-['•']と同じ手法）を空の場合だけ挿入することで、
//     DOM構造・domToPlainText等のオフセット計算に一切影響を与えずに行ボックスを1つ確保する。
// (2) min-h-[38px]: (1)だけに頼らない保険として、padding（py-2=16px）・border（1px×2）・
//     行間（text-[12.5px]×leading-[1.6]=20px）を素直に積み上げた高さを明示的な下限にする。
const CODE_BLOCK_CLASSNAME =
  "my-1 min-h-[38px] overflow-x-auto whitespace-pre rounded-md border border-line bg-surface-muted px-2.5 py-2 font-mono text-[12.5px] leading-[1.6] text-code-text empty:before:content-['']"

// 'code'（インラインコード）は2026-09-25、コード・箇条書き・引用にも「入力している時点で送信後の
// 表示を反映させたい（記号なしで）」という要望を受けてトグル書式の5番目の種類として追加した。
// 改行を含まない（`` `[^`\n]+` ``）ため、太字等と全く同じ実DOM構造の仕組み（wrapRangeInFormats・
// toggleFormatAtCursorDom・toggleFormatOnSelectionDom・isFullyWrapped・materializePendingFormats）に
// 無修正で乗る。MessageList.tsxの重なり解決はコード（優先度0）が太字等（優先度1）に常に優先し、
// コードの範囲を太字等が跨ぐと太字側が丸ごと棄却される（=送信後は効かない）仕様のため、コードは
// 他のトグル書式と組み合わせ不可能というのが送信後の実仕様——Composer.tsxのtoggleFormatButton側で
// 「codeをarmする際は他を全て置き換える」ガードを設ける（詳細はComposer.tsx参照）。
// コードブロック（```` ``` ````、複数行）はこのToggleFormatKindには含めない——改行を含み得るため
// 既存のwrapRangeInFormats等（1つの実要素に単純にネストするだけの仕組み）に乗せられず、引用と同じ
// 「1コンテナに複数行の生テキスト」という別カテゴリ（後述のdata-block-format）で扱う。
export type ToggleFormatKind = 'bold' | 'italic' | 'underline' | 'strike' | 'code'

export const TOGGLE_FORMAT_MARKERS: Record<ToggleFormatKind, { prefix: string; suffix: string }> = {
  bold: { prefix: '**', suffix: '**' },
  italic: { prefix: '_', suffix: '_' },
  underline: { prefix: '++', suffix: '++' },
  strike: { prefix: '~~', suffix: '~~' },
  code: { prefix: '`', suffix: '`' },
}

const FORMAT_ELEMENT: Record<ToggleFormatKind, { tagName: string; className: string }> = {
  bold: { tagName: 'strong', className: 'font-bold' },
  italic: { tagName: 'em', className: 'italic' },
  underline: { tagName: 'u', className: 'underline' },
  strike: { tagName: 's', className: 'line-through' },
  code: { tagName: 'code', className: CODE_CLASSNAME },
}

/** 太字・斜体・下線・取り消し線・インラインコードを表す実要素であることを示す属性（値は
 * ToggleFormatKind）。LIVE_FORMAT_ATTR（コードブロック専用、隠しマーカー方式のまま）とは
 * 意図的に別属性にしている——unwrapLiveFormattingがsyncLiveFormattingのたびに「テキストから
 * 再構築した」ラッパーだけを毎回解体・再構築するのに対し、この属性の要素は文字が入力された
 * 時点で直接構築される実体そのもの（テキストパターンから毎回導出されるものではない）ため、
 * unwrapLiveFormattingのセレクタに一切引っかからないようにする必要があるため。 */
const TOGGLE_FORMAT_ELEMENT_ATTR = 'data-toggle-format'

/** 引用・箇条書き（複数行にまたがるブロック要素）を表す実要素であることを示す属性
 * （値は'quote' | 'list' | 'list-item'）。TOGGLE_FORMAT_ELEMENT_ATTRと同じ理由で
 * unwrapLiveFormattingの対象にしない——一度実要素になったブロックは、テキストから毎回
 * 再構築するのではなく、Enter/Backspace等の操作で直接インクリメンタルに更新する
 * （2026-09-25、引用・箇条書きにも太字等と同じ「マーカー文字を一切持たない」方式を拡張した
 * 際に導入）。 */
const BLOCK_FORMAT_ATTR = 'data-block-format'

/** カーソル位置（プレーンテキストオフセット）を包むBLOCK_FORMAT_ATTR要素（引用・箇条書きの
 * 項目）を、最も内側の1つだけ返す（太字等と違い、引用・箇条書きは入れ子にならないため
 * チェーンではなく単一の要素で十分）。Composer.tsxのEnter/Backspaceハンドラが、現在行が
 * 引用/箇条書きの内側かどうかを判定するために使う。 */
export function getBlockFormatAt(root: HTMLElement, cursor: number): { el: HTMLElement; kind: string } | null {
  const pos = resolveOffset(root, cursor)
  let node: HTMLElement | null =
    pos.node.nodeType === Node.TEXT_NODE ? ((pos.node as Text).parentElement as HTMLElement | null) : (pos.node as HTMLElement)
  while (node && node !== root) {
    const kind = node.getAttribute(BLOCK_FORMAT_ATTR)
    if (kind) return { el: node, kind }
    node = node.parentElement
  }
  return null
}

/** 中身が空の<pre data-block-format="codeblock">（Composer.tsxのtoggleCodeBlockが作る、
 * その場で入力を始められる空のコードブロック）は、domToPlainText/resolveOffsetのプレーン
 * テキストオフセット上で幅0（子ノードが無く1文字も消費しない）になる。resolveOffsetのwalkは
 * 「remaining<=len」でしか要素の内部へ入れないため、幅0の要素には原理上絶対に入れず、
 * カーソルが視覚的にその内側にあってもgetBlockFormatAtは常に手前/直後の位置を返してしまう
 * （ユーザーからの報告「コードブロックボタンを押してコードブロックを出した後に、もう一度
 * コードブロックボタンを押しても、コードブロックが消えない」の原因）。整数オフセットを経由
 * せず、ブラウザの実際のSelection（anchorNode/anchorOffset）を直接読んで判定することで、
 * 空要素の内部にも問題なく対応できる（ブラウザ自身はcontentEditableな空要素の内部に普通に
 * カーソルを置ける——node=空要素自身、offset=0というRangeになる）。Composer.tsxの
 * toggleCodeBlockから、選択範囲が折りたたまれている場合のフォールバックとして使う。 */
export function getCodeBlockElementAtSelection(root: HTMLElement): HTMLElement | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.startContainer)) return null
  let target: Node = range.startContainer
  if (target.nodeType === Node.ELEMENT_NODE) {
    const children = (target as Element).childNodes
    target = children[range.startOffset] ?? target
  }
  let node: HTMLElement | null = target.nodeType === Node.TEXT_NODE ? (target as Text).parentElement : (target as HTMLElement)
  while (node && node !== root) {
    if (node.getAttribute(BLOCK_FORMAT_ATTR) === 'codeblock') return node
    node = node.parentElement
  }
  return null
}

/** rootの中から中身が空の<pre data-block-format="codeblock">を探し、見つかればその内部
 * （offset 0）へブラウザの実際のSelectionを直接置く。ユーザーからの報告「コードブロック
 * ボタンを押すと、コードブロック内ではなく下の普通の所にカーソルが合ってしまう」への対処。
 * toggleCodeBlockの「空行に新規作成」経路は、生の"```\n\n```"マーカー文字列を挿入して
 * syncLiveFormatting（consumeCodeBlockMatches）に実DOM変換を任せる方式のため、変換後の
 * カーソル位置はsyncLiveFormatting自身の目印文字ベースの選択範囲保存・復元に委ねるほかない。
 * ここで作られる<pre>は中身が0文字（wrapRangeAsCodeBlockと違い空範囲を直接扱えないための
 * 回避策）で、getCodeBlockElementAtSelectionのコメントで説明した「幅0の要素には整数オフセット
 * では入れない」問題があるうえ、この変換自体が複数段階の破壊的なテキスト分割（前後の3連
 * バッククォート・改行を個別に切り出す）を経るため、目印文字が最終的にどこへ着地するかの
 * 保証が弱い。afterMutateの直後に要素そのものへの参照で直接re-focusすることで、整数
 * オフセット・目印文字のどちらの経路にも頼らず一意にカーソル位置を確定させる。 */
export function focusEmptyCodeBlock(root: HTMLElement): boolean {
  const blocks = root.querySelectorAll<HTMLElement>(`[${BLOCK_FORMAT_ATTR}="codeblock"]`)
  const target = Array.from(blocks).find((el) => domToPlainText(el).length === 0)
  if (!target) return false
  const range = document.createRange()
  range.setStart(target, 0)
  range.collapse(true)
  const sel = window.getSelection()
  if (!sel) return false
  sel.removeAllRanges()
  sel.addRange(range)
  return true
}

/** カーソル位置（プレーンテキストオフセット）を包むインラインコード実要素
 * （TOGGLE_FORMAT_ELEMENT_ATTR="code"）があれば返す。太字・斜体・下線・取り消し線と違い
 * インラインコードだけは改行を含められない（MessageList.tsxのINLINE_CODE_REGEXが
 * `` `[^`\n]+` ``で改行を除外しているため）——バグ修正（ユーザーからの報告「コード表記で
 * 入力しているときに、途中でEnterを押して改行してから送信すると、コード表示ではなくなる」）:
 * Composer.tsxのEnterハンドラは従来、カーソルがインラインコードの内側にいるかどうかを一切
 * 見ておらず、生の"\n"をそのままインラインコード要素の中へ挿入していた。送信時のMarkdownは
 * 改行を含む`` `...\n...` ``になり、送信側・受信側どちらの正規表現にも一致せず（コード
 * ブロックの```でもインラインコードの単一`` ` ``でもない）、生の記号付きプレーンテキストとして
 * 表示されてしまっていた。Enterハンドラがこの関数でカーソル位置を判定し、該当すればコード
 * ブロックへ自動アップグレードする（Composer.tsxのwrapCodeが選択範囲に改行を含む場合と
 * 同じ「GitHubのコメント欄と同じ挙動」の考え方を、ボタンではなく生タイプ時にも広げたもの）。 */
export function getInlineCodeElementAt(root: HTMLElement, cursor: number): HTMLElement | null {
  const pos = resolveOffset(root, cursor)
  let node: HTMLElement | null =
    pos.node.nodeType === Node.TEXT_NODE ? ((pos.node as Text).parentElement as HTMLElement | null) : (pos.node as HTMLElement)
  while (node && node !== root) {
    if (node.getAttribute(TOGGLE_FORMAT_ELEMENT_ATTR) === 'code') return node
    node = node.parentElement
  }
  return null
}

// MessageList.tsxのBOLD_REGEX/ITALIC_REGEX/UNDERLINE_REGEX/STRIKE_REGEXと同じ定義（1文字以上
// 必須）。手打ちの生Markdown（consumeRawMarkdownSyntax）を検出するためのもので、送信後の
// 実際の解釈と完全に一致させる（かつてのLIVE_*_REGEXは「ボタンで開いた空のマーカー対」を
// 隠すための0文字以上版だったが、その仕組み自体が無くなったため1文字以上必須の実際の仕様に
// 統一した）。
const RAW_BOLD_REGEX = /\*\*([\s\S]+?)\*\*/g
const RAW_ITALIC_REGEX = /_([\s\S]+?)_/g
const RAW_UNDERLINE_REGEX = /\+\+([\s\S]+?)\+\+/g
const RAW_STRIKE_REGEX = /~~([\s\S]+?)~~/g

interface LiveMatch {
  start: number
  end: number
  priority: number
  // 'codeblock'（```` ``` ````、複数行）はToggleFormatKindに含めない別カテゴリ（本ファイル前方の
  // ToggleFormatKindコメント参照）。collectRawMarkdownMatchesの重なり判定にのみ使い、返り値からは
  // 除外する（コードブロック自体の構造化は別途consumeCodeBlockMatchが担当）。
  kind: 'codeblock' | ToggleFormatKind
}

/** RAW_CODE_BLOCK_REGEXで完成している（開始・終了の```が揃っている）ペアに加え、終了側の```が
 * まだ入力されていない「入力中の」コードブロック（最後の対になっていない```から文末までを
 * 暫定的に保護対象とする）も含めて返す。
 *
 * バグ修正（Playwrightでのコードブロック検証中に発見）: この保護が無いと、コードブロックの
 * 中身を上から順に手打ちしている最中（終了側の```をまだ打っていない状態）に、中の
 * `**bold**`等や行頭の「> 」が「コードブロックの外の生テキスト」として先に太字・引用へ
 * 確定してしまい、終了側の```を打って初めてコードブロックだと判明した後もそのまま実要素と
 * して残ってしまっていた（一度実要素へ変換された太字等・引用は、このファイルの新方式では
 * 太字等と同じくテキストから毎回再構築される存在ではないため、後から取り消されない）。
 * 対になっていない```の位置は、文中の```の出現位置を先頭から順に数え、奇数個なら最後の
 * 1つが未対応と判定する（RAW_CODE_BLOCK_REGEXの非貪欲マッチが左から順に隣接ペアを消費して
 * いくのと同じ規則）。collectRawMarkdownMatchesの重なり判定・syncLiveFormattingの
 * codeBlockRanges（引用検出からの除外）の両方から使う。 */
function findCodeBlockProtectedRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  for (const m of text.matchAll(RAW_CODE_BLOCK_REGEX)) {
    const start = m.index ?? 0
    ranges.push({ start, end: start + m[0].length })
  }
  const delimIndices: number[] = []
  let searchFrom = 0
  while (true) {
    const idx = text.indexOf('```', searchFrom)
    if (idx === -1) break
    delimIndices.push(idx)
    searchFrom = idx + 3
  }
  if (delimIndices.length % 2 === 1) {
    ranges.push({ start: delimIndices[delimIndices.length - 1], end: text.length })
  }
  return ranges
}

/** 太字・斜体・下線・取り消し線・インラインコード（RAW_*_REGEX、1文字以上必須）を候補に含めた
 * 優先度付き重なり解決（MessageList.tsxのcollectStyleMatchesと同じアルゴリズム）。コードブロック
 * （```` ``` ````、複数行）は重なり判定の優先度としてのみ使い（コードブロックの中の見かけ上の
 * **等・`` ` ``等を誤って書式と解釈しないようにするため）、返り値からは除外する（コードブロック
 * 自体の構造化はsyncLiveFormatting側で別途consumeCodeBlockMatchesが担当する）。インラインコードは
 * コードブロックと違い改行を含まないためToggleFormatKindの一種として返り値に含め、他の書式と
 * 全く同じ経路（consumeOneRawMatch）で実要素へ変換する。インラインコードの優先度をコードブロックと
 * 同じ0（太字等より高い）にするのはMessageList.tsxのcollectStyleMatchesと同じ理由（コード範囲の
 * 中の見かけ上の**等を誤って書式と解釈しないようにするため）。consumeRawMarkdownSyntaxから使う。 */
function collectRawMarkdownMatches(text: string): LiveMatch[] {
  const candidates: LiveMatch[] = []
  for (const r of findCodeBlockProtectedRanges(text)) {
    candidates.push({ start: r.start, end: r.end, priority: 0, kind: 'codeblock' })
  }
  for (const m of text.matchAll(INLINE_CODE_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 0, kind: 'code' })
  }
  for (const m of text.matchAll(RAW_BOLD_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 1, kind: 'bold' })
  }
  for (const m of text.matchAll(RAW_ITALIC_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 1, kind: 'italic' })
  }
  for (const m of text.matchAll(RAW_UNDERLINE_REGEX)) {
    const start = m.index ?? 0
    candidates.push({ start, end: start + m[0].length, priority: 1, kind: 'underline' })
  }
  for (const m of text.matchAll(RAW_STRIKE_REGEX)) {
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
  return accepted.filter((m) => m.kind !== 'codeblock')
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

// 引用のライブプレビュー（ユーザーからの明示的な要望「>を入力した時点で、送った後に出てくる
// 灰色の線みたいなものを表示させるようにしたい」、2026-09-25「入力している時点で送信後の表示を
// 反映させたい（記号なしで）」で全面書き換え）。太字等と異なり、引用は「行頭に閉じマーカーの
// 無いプレフィックス（「> 」）が続く」という行単位のブロック構造のため、専用の検出処理を持つ。
// MessageList.tsxのsplitLineBlocksと同じ考え方（連続する「> 」行を1つの引用ブロックとして
// まとめる）で範囲を検出し、その範囲全体をMessageList.tsxの送信後表示と全く同じクラス
// （QUOTE_BLOCKQUOTE_CLASSNAME）の<blockquote data-block-format="quote">で包む。太字等と同じく
// マーカー文字（「> 」）は隠すのではなく削除する——一度<blockquote>になった後は
// unwrapLiveFormattingの対象外（上記コメント参照）なので、以後は毎回テキストから再構築される
// のではなく、Composer.tsxのEnterキー処理がDOMを直接インクリメンタルに更新する（既存の
// <blockquote>内に生の"\n"を挿入するだけで続き行になり、逆にDOMから抜けるだけで終了する）。
// 検出（collectQuoteRanges）自体は太字等がまだ実要素化されていない生テキストの状態でも
// 行頭の「> 」を見つけられれば良いため無修正のまま。中の太字・インラインコード等は
// consumeRawMarkdownSyntaxがこの関数より先に文書全体へ対して実行済みのため、ここで
// 改めて検出し直す必要はない（wrapQuoteRangeは「> 」を消して<blockquote>で包むだけで良い）。
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

/** [start,end)をcontainerから削除するだけの汎用ヘルパー（deleteRangeReturningCollapsedの
 * HTMLElement専属版と違い、DocumentFragment等どんなcontainerに対しても使える、選択範囲を
 * 気にしない単純な削除）。wrapQuoteRangeが「> 」マーカー文字を消し去るために使う。 */
function deleteRangeInContainer(container: Node, start: number, end: number): void {
  if (start >= end) return
  const startPos = resolveOffset(container, start)
  const endPos = resolveOffset(container, end)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  range.deleteContents()
}

/** [start,end)の範囲を<blockquote data-block-format="quote">で直接包む（マーカー文字「> 」の
 * 存在を前提にしない）。Composer.tsxのinsertQuote（ボタン駆動）・wrapQuoteRange（手打ち検出）の
 * 両方から使う共通の構築ロジック（convertLinesToListItemsと同じ役割分担）。 */
export function convertLinesToQuote(root: HTMLElement, start: number, end: number): void {
  // start===endは「何も入力されていない行」で引用ボタンを押した場合（ユーザーからの要望
  // 「引用ボタンを押した時点で引用の表示が出るようにしたい」、convertLinesToListItemsの
  // 空行対応と同じ）に、cursor位置のRangeをそのまま切り出して空のblockquoteを作る。
  if (start > end) return
  const startPos = resolveOffset(root, start)
  const endPos = resolveOffset(root, end)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  const fragment = range.extractContents()

  const wrapper = document.createElement('blockquote')
  wrapper.setAttribute(BLOCK_FORMAT_ATTR, 'quote')
  wrapper.className = QUOTE_BLOCKQUOTE_CLASSNAME
  wrapper.appendChild(fragment)
  range.insertNode(wrapper)

  // convertLinesToListItemsの空項目キャレット処理と同じ理由（extractContents/insertNodeで
  // 元のSelectionが道連れで無効化されるため、CARET_MARKERを実在させて明示的にキャレットを置く）。
  if (start === end) {
    const marker = document.createTextNode(CARET_MARKER)
    wrapper.appendChild(marker)
    const caretRange = document.createRange()
    caretRange.setStart(marker, marker.length)
    caretRange.collapse(true)
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(caretRange)
    }
  }
}

/** 検出済みの引用範囲（collectQuoteRanges）の各行頭の「> 」マーカーを削除してから
 * convertLinesToQuoteで構築する（wrapBulletRangeの「- 」削除と全く同じロジック——降順で
 * 処理しないと、先に削除した行より後方のオフセットが崩れる）。 */
function wrapQuoteRange(root: HTMLElement, quoteRange: QuoteRange): void {
  const { start, end } = quoteRange
  if (start >= end) return
  const lineTexts = domToPlainText(root).slice(start, end).split('\n')
  const markerOffsets: number[] = []
  let pos = start
  for (const line of lineTexts) {
    markerOffsets.push(pos)
    pos += line.length + 1
  }
  for (const off of [...markerOffsets].reverse()) deleteRangeInContainer(root, off, off + 2)
  convertLinesToQuote(root, start, end - markerOffsets.length * 2)
}

// 箇条書き（「- 」）のライブプレビュー（2026-09-25、「入力している時点で送信後の表示を反映させたい
// （記号なしで）」という要望を受けて新規追加）。引用・コードブロックと違い、箇条書きは送信後に
// 行ごとに実際の黒丸（<li>）が付くため、「1コンテナに複数行の生テキスト」というモデルでは
// 行ごとの黒丸を表現できない。そのため箇条書きだけは「1行=1つのdata-block-format="list-item"
// 要素」という別モデルを採る（data-block-format="list"の親要素が複数のlist-itemを子に持つ）。
// 項目と項目の間は本ファイル前方のdomToPlainText/resolveOffset/domPositionToOffset/domToMarkdown
// で「原子的な1文字ぶんの仮想区切り」として扱う（絵文字img・マーカーspanと同じパターンを
// コンテナレベルに適用しただけ）。黒丸はCSSの::before疑似要素で付ける（display:list-item は
// マーカーボックスがRange/Selection APIの挙動に干渉するリスクがあるため避けた。疑似要素は
// DOM/Rangeツリーに一切含まれないため安全）。
const LIST_CLASSNAME = 'my-1 space-y-0.5'
const LIST_ITEM_CLASSNAME = "relative pl-5 before:absolute before:left-1.5 before:content-['•'] before:text-ink-subtle"
const BULLET_LINE_REGEX = /^- (.+)$/

interface BulletRange {
  start: number
  end: number
}

/** 連続する「- 」行を1つの範囲としてまとめて返す（collectQuoteRangesと全く同じアルゴリズム）。 */
function collectBulletRanges(text: string, excludeRanges: { start: number; end: number }[]): BulletRange[] {
  const ranges: BulletRange[] = []
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
    if (BULLET_LINE_REGEX.test(line)) {
      if (blockStart === null) blockStart = lineStart
    } else {
      closeBlock(lineStart === 0 ? 0 : lineStart - 1)
    }
    lineStart += line.length + 1
  }
  closeBlock(text.length)
  return ranges
}

function buildListItemElement(content: Node): HTMLDivElement {
  const item = document.createElement('div')
  item.setAttribute(BLOCK_FORMAT_ATTR, 'list-item')
  item.className = LIST_ITEM_CLASSNAME
  item.appendChild(content)
  return item
}

/** [start,end)の範囲（複数行）を、行ごとに独立したlist-item要素へ詰め替えた
 * data-block-format="list"でまとめて置き換える。太字等が既に実要素化済みでも（行の境界を
 * またがない限り）正しく保持される。ボタン駆動（Composer.tsxのinsertBulletList）・手打ち
 * 検出（wrapBulletRange）の両方から使う共通の構築ロジック。 */
export function convertLinesToListItems(root: HTMLElement, start: number, end: number): void {
  // start===endは「何も入力されていない行」で箇条書きボタンを押した場合（ユーザーからの要望
  // 「何も入力されていない行で箇条書きボタンを押しても箇条書きのマークが出てくるようにしたい」、
  // insertQuoteの空行対応と同じ）に、cursor位置のRangeをそのまま切り出す（空のfragment→
  // domToPlainTextが""→split('\n')が['']になり、下のループが自然に1つの空項目を作る）。
  // 呼び出し元（wrapBulletRange）は常にstart<endの非空範囲しか渡さないため、この経路が
  // 実際に使われるのはComposer.tsxのボタン駆動の空行ケースのみ。
  if (start > end) return
  const startPos = resolveOffset(root, start)
  const endPos = resolveOffset(root, end)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  const fragment = range.extractContents()

  const lineTexts = domToPlainText(fragment).split('\n')
  const lineStarts: number[] = []
  let pos = 0
  for (const line of lineTexts) {
    lineStarts.push(pos)
    pos += line.length + 1
  }

  // 末尾の行から処理する（先に処理した行より後方のオフセットを崩さないため、
  // consumeRawMarkdownSyntax等と同じ理由）。各行の直後に残る区切りの"\n"は、要素境界が
  // その役割を引き継ぐため不要——行の中身を切り出す前に先に取り除く（中身を切り出した後だと
  // 残りのfragmentが縮んでオフセットがずれるため、順序が重要）。
  const items: HTMLDivElement[] = []
  for (let i = lineTexts.length - 1; i >= 0; i--) {
    const lineStart = lineStarts[i]
    const lineEnd = lineStart + lineTexts[i].length
    if (i < lineTexts.length - 1) {
      deleteRangeInContainer(fragment, lineEnd, lineEnd + 1)
    }
    const lStartPos = resolveOffset(fragment, lineStart)
    const lEndPos = resolveOffset(fragment, lineEnd)
    const lineRange = document.createRange()
    lineRange.setStart(lStartPos.node, lStartPos.offset)
    lineRange.setEnd(lEndPos.node, lEndPos.offset)
    items.unshift(buildListItemElement(lineRange.extractContents()))
  }

  const listEl = document.createElement('div')
  listEl.setAttribute(BLOCK_FORMAT_ATTR, 'list')
  listEl.className = LIST_CLASSNAME
  for (const item of items) listEl.appendChild(item)
  range.insertNode(listEl)

  // バグ修正（ユーザーからの報告「箇条書きの記法ができなくなっている」、jsdomでの再現テストで
  // 発見）: start===end（何も入力されていない行でボタンを押した場合）は唯一の項目が完全に
  // 空になる。この関数はSelectionに一切触れないため、range.extractContents/insertNodeで
  // 元の位置を指していたSelectionが道連れで無効化され、handleEnterInListItemの空項目分岐と
  // 同じ「resolveOffsetの境界タイのバイアス」により、続けて入力した文字がこの空項目の内側
  // ではなくリストの外（直前）へ入ってしまっていた。CARET_MARKER（ゼロ幅スペース）を空項目に
  // 実在させ、その直後へ明示的にキャレットを置く（handleEnterInListItemと同じ手法）。
  // start<end（非空行の変換、Composer.tsxのinsertBulletList）は呼び出し元がstart/end自体を
  // そのままsetSelectionOffsetsへ渡せば正しく解決するため、ここでは何もしない。
  if (start === end) {
    const item = listEl.firstElementChild as HTMLElement
    const marker = document.createTextNode(CARET_MARKER)
    item.appendChild(marker)
    const caretRange = document.createRange()
    caretRange.setStart(marker, marker.length)
    caretRange.collapse(true)
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(caretRange)
    }
  }
}

/** 検出済みの箇条書き範囲をconvertLinesToListItemsで構築する。syncLiveFormattingの
 * 手打ち検出パイプラインから使う（collectBulletRanges参照）。 */
/** 検出済みの箇条書き範囲の各行頭の「- 」を削除してからconvertLinesToListItemsで構築する
 * （wrapQuoteRangeの「> 」削除と全く同じロジック——降順で処理しないと、先に削除した行より
 * 後方のオフセットが崩れる）。convertLinesToListItems自体はボタン駆動（マーカー文字を
 * 経由しない）とこの手打ち検出の両方から共有されるため、マーカー削除はこの関数の責務にする。 */
function wrapBulletRange(root: HTMLElement, bulletRange: BulletRange): void {
  const { start, end } = bulletRange
  if (start >= end) return
  const lineTexts = domToPlainText(root).slice(start, end).split('\n')
  const markerOffsets: number[] = []
  let pos = start
  for (const line of lineTexts) {
    markerOffsets.push(pos)
    pos += line.length + 1
  }
  for (const off of [...markerOffsets].reverse()) deleteRangeInContainer(root, off, off + 2)
  convertLinesToListItems(root, start, end - markerOffsets.length * 2)
}

/** data-block-format="list"要素を解除し、各項目の中身を実在の"\n"区切りの生テキストへ戻す
 * （convertLinesToListItemsの逆操作）。Composer.tsxのinsertBulletList（既存の箇条書きを
 * 解除する方向）・handleBackspaceAtListItemStart（先頭項目でのBackspace脱出）から使う。 */
export function ungroupListElement(listEl: HTMLElement): void {
  const parent = listEl.parentNode
  if (!parent) return
  const items = Array.from(listEl.children)
  const frag = document.createDocumentFragment()
  items.forEach((item, i) => {
    if (i > 0) frag.appendChild(document.createTextNode('\n'))
    while (item.firstChild) frag.appendChild(item.firstChild)
  })
  parent.insertBefore(frag, listEl)
  parent.removeChild(listEl)
}

/** 空のlist-item（黒点だけで中身が無い項目）をリストから外し、その場をプレーンな空行に
 * 差し替える（Notion・GitHub等と同じ「黒点だけを消して行自体は残す」脱出操作）。
 * handleEnterInListItem（空項目でEnterを確定した場合）・handleBackspaceAtListItemStart
 * （空項目の先頭でBackspaceを押した場合、ユーザーからの報告「箇条書きの黒点だけの行で
 * Backspace/Deleteキーを押しても点を消せない」への対応）の両方から使う共通処理。呼び出し元は
 * itemElの中身が本当に空（CARET_MARKER除去済み）であることを保証してから呼ぶこと。リストの
 * 最後の項目がこれだけだった場合はリスト自体を消し、その場をプレーンな空行に置き換える。 */
function exitEmptyListItem(itemEl: HTMLElement): void {
  const listEl = itemEl.parentElement as HTMLElement
  itemEl.remove()
  if (listEl.children.length === 0) {
    // バグ修正（ユーザーからの報告「箇条書きの黒点を表示している行で何も入力せずEnterで
    // 改行すると、なぜか一行分のスペースが開いて次の行に行く」）: この分岐（唯一の項目を
    // 削除してリスト自体が空になった場合）も、以前はリストを取り除いた場所へ実在の"\n"文字を
    // 置いていた。下のコメントで説明する「ブロック要素の直後の改行文字が二重になる」現象は、
    // 実は「ブロックの直後」に限らず「何も無い行の先頭（＝まだ何の文字も置かれていない、
    // 生成されたばかりの行）に実在の改行文字を置く」場合全般で起きることをisolate.htmlの
    // 追加検証（先行する兄弟が何も無いケース）で確認した。リストがまだ他の項目を持つ場合と
    // 同じ対処（実在の"\n"を置かず、キャレット表示用のCARET_MARKERだけを置く）をここでも行う。
    // このリストの直前に何かがあった場合、それは必ず（Enter押下やbulletRange検出の性質上）
    // 実在の"\n"で終わっているか、さもなくば本文の先頭であるため、送信用Markdownを組み立てる
    // domToMarkdown側での区切りの補完（箇条書きが他の項目を残す場合の分岐で行っているもの）は
    // ここでは不要——直前の内容が既に正しく行を終えている。
    const parent = listEl.parentNode as Node
    const anchor = listEl.nextSibling
    listEl.remove()
    const marker = document.createTextNode(CARET_MARKER)
    parent.insertBefore(marker, anchor)
    const range = document.createRange()
    range.setStart(marker, marker.length)
    range.collapse(true)
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
    return
  }
  // バグ修正（ユーザーからの報告「箇条書きで黒点を消すと不自然な空行ができる」、isolate.htmlでの
  // 検証で判明）: リストが他の項目を残して続く場合、以前はここで実在の"\n"文字をリストの直後へ
  // 挿入していた。ブロック要素（<div data-block-format="list">、display:blockでそれ自体が
  // 既に新しい行を作る）の直後に実在の"\n"を置くと、white-space:pre-wrap下では「ブロックの
  // 直後で既に新しい行が始まっている」うえに、その"\n"自体もさらに改行を1つ作るため、
  // 実機検証（isolate.html、4パターンの高さ比較）で改行1個ぶん（約20px）よけいに背が高くなる
  // ことを確認した（<br>に置き換えても同じ結果で、要素の種類の問題ではなく「ブロック直後の
  // 改行文字は常に二重になる」というwhite-space:pre-wrapの一般的な性質だと判明）。
  // 対策として、ここでは実在の"\n"を一切挿入せず、キャレット表示用のCARET_MARKERだけを
  // リストの直後へ置く（ブロックの直後で改行文字が無ければ二重にならないことも同じ検証で
  // 確認済み）。この結果、DOM上はリストの直後に実在の"\n"を持たなくなるため、
  // domToPlainText（カーソル位置計算やDOM操作と一致させる必要がある値のため、意図的に
  // このブロックの実装は変更しない）は箇条書きとその直後の文章を区切り無しで返すが、
  // 送信直前のMarkdown文字列を作るdomToMarkdownの側だけで、ブロックの直後に実際に何か
  // 文字が続く場合に"\n"を1つ補う（詳細は同関数のコメント参照）。
  const marker = document.createTextNode(CARET_MARKER)
  const parent = listEl.parentNode as Node
  parent.insertBefore(marker, listEl.nextSibling)
  const range = document.createRange()
  range.setStart(marker, marker.length)
  range.collapse(true)
  const sel = window.getSelection()
  if (sel) {
    sel.removeAllRanges()
    sel.addRange(range)
  }
}

/** list-item内でEnterを押した結果を処理する。Composer.tsxのhandleKeyDownが、cursorが
 * getBlockFormatAtで'list-item'と判定された場合にのみ呼ぶ。項目が空ならリストを抜ける
 * （Notion・GitHub等と同じ、既存の引用の「空行で抜ける」と同じ考え方）。空でなければ
 * カーソル以降の既入力内容を新しい項目として直後に挿入する（前回セッションの
 * toggleFormatAtCursorDomの「内側でない書式解除」で使った“末尾を切り出して兄弟として
 * 挿入”と同じパターンの再利用）。
 *
 * バグ修正（実機Playwright検証で発見）: 分割で新しく作った項目にはCARET_MARKER（下記参照）が
 * 実在するが、Enterキーはネイティブのinputイベントを経由しない（handleKeyDownが自前で
 * preventDefaultして処理する）ため、通常なら次の入力のたびにhandleInputの冒頭が片付ける
 * CARET_MARKERがEnterキー連打では片付かないまま残ってしまい、続けてEnterを押すと「項目の
 * 中身はCARET_MARKERの1文字だけ＝空ではない」と誤判定されてしまっていた（空行のはずなのに
 * 分割が続いてしまう）。呼び出しの冒頭で明示的に片付け、その後の絶対オフセットも
 * （マーカー除去で1文字ぶんずれるため）ライブなSelectionから読み直す。 */
export function handleEnterInListItem(root: HTMLElement, itemEl: HTMLElement, cursor: number): void {
  removeCaretMarkerFromDom(root)
  cursor = getSelectionOffsets(root)?.start ?? cursor
  const itemRange = computeElementOffset(root, itemEl)
  const listEl = itemEl.parentElement as HTMLElement

  if (itemRange.start === itemRange.end) {
    exitEmptyListItem(itemEl)
    return
  }

  const startPos = resolveOffset(root, cursor)
  const endPos = resolveOffset(root, itemRange.end)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  const tail = range.extractContents()
  const newItem = buildListItemElement(tail)
  listEl.insertBefore(newItem, itemEl.nextSibling)
  // バグ修正（実機Playwright検証で発見）: cursor（分割前の絶対オフセット、＝新しい項目の
  // 先頭と数値上は同じ値）をそのままsetSelectionOffsetsへ渡すと、resolveOffsetが「その位置は
  // 直前の項目の末尾でも表現できる」という既知のバイアス（ties resolve to the end of the
  // preceding content、toggleFormatAtCursorDomのコメント参照）により、新しい項目の内側では
  // なく直前の項目の内側に留まってしまう——新しい項目の要素参照を直接使ってSelectionを
  // 明示的に置いても、この直後にComposer.tsxのafterMutateが呼ぶsyncLiveFormatting自身が
  // 選択範囲を数値オフセットで保存・復元し直すため、同じ問題がもう一度再発する（restoreした
  // 瞬間にresolveOffsetの同じバイアスを踏む）。toggleFormatAtCursorDom・restoreSelectionFromMarkers
  // と同じ対処として、新しい項目の先頭にCARET_MARKER（ゼロ幅スペース）を実在させ、その直後へ
  // Selectionを置く（中身が空でない実在のテキストノードとして退出点を確実に生き残らせる）。
  const marker = document.createTextNode(CARET_MARKER)
  newItem.insertBefore(marker, newItem.firstChild)
  const newRange = document.createRange()
  newRange.setStart(marker, marker.length)
  newRange.collapse(true)
  const sel = window.getSelection()
  if (sel) {
    sel.removeAllRanges()
    sel.addRange(newRange)
  }
}

/** list-itemの絶対オフセット0（項目の先頭）でBackspaceを押した結果を処理する。
 * Composer.tsxのhandleKeyDownが、cursorがちょうど項目の先頭と一致する場合にのみ呼ぶ
 * （それ以外のBackspaceは今まで通りネイティブ処理に任せ、一切介入しない）。項目またぎの
 * ブロック要素の結合はブラウザ間の挙動が大きく異なるため、Enterと同じ理由で自前実装する
 * （ファイル冒頭の設計判断コメント参照）。直前に項目があれば現項目の中身を直前の項目の
 * 末尾へ移動して現項目を削除する。直前の項目が無い（先頭かつ唯一の項目）ならリストごと
 * 平文へ戻す。
 *
 * バグ修正（ユーザーからの報告「箇条書きの黒点だけの行でBackspace/Deleteキーを押しても
 * 点を消せない（黒点が無い行を作りたい）」）: 項目の中身が本当に空（何も入力していない黒点
 * だけの行）で、かつ直前に項目がある場合は、直前の項目へ「結合」するのではなく、
 * handleEnterInListItemが空項目のEnterで抜けるときと同じexitEmptyListItem（黒点を消して
 * その場をプレーンな空行に差し替える）を使う。中身が空でない項目（カーソルは項目の先頭に
 * あるが後ろに文字が続いている、通常の「行頭でBackspaceして前の行と連結する」ケース）は
 * 従来どおり直前の項目へ結合する。 */
export function handleBackspaceAtListItemStart(root: HTMLElement, itemEl: HTMLElement): void {
  const listEl = itemEl.parentElement as HTMLElement
  const prevItem = itemEl.previousElementSibling as HTMLElement | null
  const itemRange = computeElementOffset(root, itemEl)

  if (itemRange.start === itemRange.end && prevItem) {
    exitEmptyListItem(itemEl)
    return
  }

  if (!prevItem) {
    const cursor = getSelectionOffsets(root)?.start
    ungroupListElement(listEl)
    if (cursor !== undefined) setSelectionOffsets(root, cursor)
    return
  }

  const mergeAt = computeElementOffset(root, prevItem).end
  while (itemEl.firstChild) prevItem.appendChild(itemEl.firstChild)
  itemEl.remove()
  setSelectionOffsets(root, mergeAt)
}

/** 太字・斜体・下線・取り消し線の実要素（TOGGLE_FORMAT_ELEMENT_ATTR）のうち、中身が空文字に
 * なったもの（Backspace/Deleteで最後の1文字を消しきった等）を取り除く。ブラウザはBackspace等で
 * 最後の文字を消しても空の<strong></strong>を自動では片付けないため、消さずに放置すると
 * domToMarkdownが（安全策として空なら記号を出さないとはいえ）無駄な空要素を持ち続け、また
 * toggleFormatAtCursorDom等の判定を複雑にする。中身が空の要素を消しても文字数は変化しない
 * ため、カーソル位置の保存・復元は不要（呼び出し元のsyncLiveFormattingが行う保存・復元の
 * 範囲外で安全に呼べる）。 */
function removeEmptyToggleFormatWrappers(root: HTMLElement): void {
  const wrappers = root.querySelectorAll(`[${TOGGLE_FORMAT_ELEMENT_ATTR}]`)
  wrappers.forEach((el) => {
    if (textLength(el) === 0) el.remove()
  })
}

/** コードブロック（<pre data-block-format="codeblock">）のうち、中身をDelete/Backspaceで
 * 全て消し切って空になったものを取り除く（removeEmptyToggleFormatWrappersと同じ理由・同じ
 * 安全性——空要素の除去は文字数を変えないため、呼び出し元の選択範囲の保存・復元の範囲外で
 * 安全に呼べる）。バグ修正（ユーザーからの報告「コードブロックになったときに、中の文章を
 * すべて消してもコードブロックの枠自体が消えない。入力中の判定にはなる（下書きが保存される）
 * のに本文が空で送信もできない、という矛盾した状態になる」）: 太字等の実要素はこの関数の
 * すぐ上で自動的に片付けているが、引用・箇条書き・コードブロック（BLOCK_FORMAT_ATTR）は
 * unwrapLiveFormattingの対象外（syncLiveFormattingの冒頭コメント参照）のため、同じ掃除が
 * されていなかった。引用・箇条書きは既に専用のBackspace/Enter処理で空行/空項目からの
 * 脱出を扱っているため対象外とし、そうした専用処理を持たないコードブロックだけをここで
 * 対象にする。 */
function removeEmptyCodeBlocks(root: HTMLElement): void {
  const blocks = root.querySelectorAll(`[${BLOCK_FORMAT_ATTR}="codeblock"]`)
  blocks.forEach((el) => {
    if (domToPlainText(el).length === 0) el.remove()
  })
}

/** 書式のライブプレビューを最新化する。ネイティブ入力・IME確定・ツールバー操作・メンション/
 * 絵文字挿入・貼り付け・下書き復元など、本文が変わりうるあらゆる箇所の後に呼ぶ想定
 * （Composer.tsxのrefreshEditorHousekeeping、実質すべての変更経路を1箇所に集約している）。
 * 呼ぶたびに全体を作り直す設計のため冪等（何度呼んでも同じ結果になる）。
 *
 * 太字・斜体・下線・取り消し線・インラインコード（実DOM構造、TOGGLE_FORMAT_ELEMENT_ATTR）・
 * 引用・コードブロック（BLOCK_FORMAT_ATTR）は一切unwrapされず、consumeRawMarkdownSyntax・
 * consumeCodeBlockMatchesが手打ちの生Markdownだけを検出して実要素へ破壊的に変換する
 * （詳細は本ファイル前方の書式セクションの冒頭コメント参照）。 */
export function syncLiveFormatting(root: HTMLElement): void {
  root.normalize()
  removeEmptyToggleFormatWrappers(root)
  removeEmptyCodeBlocks(root)

  // バグ修正（実機Playwright検証で発見。ユーザーからの報告「引用の中で手打ちの**bold**が
  // 閉じた直後、続けて打った文字までbold扱いになってしまう」）: 選択範囲の保存・復元を
  // consumeRawMarkdownSyntax単独の中に閉じ込めていた頃は、そこでは正しく復元できても、
  // 直後にこの関数自身が行う「引用・コードのwrap処理をまたぐための」別の数値オフセットの
  // 保存・復元がもう一度走り、そちらが「閉じたばかりの実要素の直後」という境界を数値
  // オフセットのround-tripだけで復元しようとして同じ問題（resolveOffsetが手前の要素の内側に
  // 留まる位置を返すバイアス、toggleFormatAtCursorDomのコメント参照）を再発させていた。
  // 目印文字（SELECTION_START_MARKER/SELECTION_END_MARKER）の挿入・復元をこの関数1箇所に
  // 一本化し、consumeRawMarkdownSyntax・引用・コードのwrap処理すべてをその内側で行うことで、
  // 数値オフセットのround-tripを最後の1回（restoreSelectionFromMarkers、ノード参照を直接
  // 使うため境界のあいまいさが無い）だけに絞る。
  const preserved = getSelectionOffsets(root)
  const hasRange = !!preserved && preserved.start !== preserved.end
  // 目印文字を使った保存・復元は、実際に生Markdownの変換が起きる場合（＝consumeRawMarkdownSyntax
  // が本文を書き換え、要素境界のあいまいさが生じ得る場合）だけに限定する。何も変換が起きない
  // 大多数のキーストローク（引用・コードのwrapだけ、あるいは何もwrapしない）では、この目印文字を
  // 挿入すると、それが後述のrestoreSelectionFromMarkersでCARET_MARKERへ置き換えられて本文に
  // 残ってしまい（次に実際の文字が入力されるまで消えない）、不要な副作用になる。変換が起きない
  // 場合は元の単純な数値オフセットの保存・復元で十分（引用・コードのwrapだけなら要素境界の
  // あいまいさの問題は実際には起きないため——このタイミングで新しく実要素が生まれるのは
  // consumeRawMarkdownSyntaxが変換したときだけ）。
  const rawMatches = collectRawMarkdownMatches(domToPlainText(root))
  const useMarkerBasedRestore = !!preserved && rawMatches.length > 0

  if (useMarkerBasedRestore && preserved) {
    const snap = (x: number): number => {
      for (const m of rawMatches) {
        const { prefix, suffix } = TOGGLE_FORMAT_MARKERS[m.kind as ToggleFormatKind]
        if (x > m.start && x < m.start + prefix.length) return m.start + prefix.length
        if (x > m.end - suffix.length && x < m.end) return m.end - suffix.length
      }
      return x
    }
    const start = snap(preserved.start)
    const end = snap(preserved.end)
    // 終端側を先に挿入してから始端側を挿入する（始端側の挿入が終端側のオフセットへ影響
    // しない順序にする）
    if (start === end) {
      replaceRangeWithText(root, start, start, SELECTION_START_MARKER)
    } else {
      replaceRangeWithText(root, end, end, SELECTION_END_MARKER)
      replaceRangeWithText(root, start, start, SELECTION_START_MARKER)
    }
  }

  // 太字・斜体・下線・取り消し線・インラインコードを先に実要素へ変換する（コードブロックの
  // 範囲はcollectRawMarkdownMatchesの優先度付き重なり判定により自動的に保護される——コードブロック
  // の中の見かけ上の**や`はこの時点ではまだ手つかずの生テキストのまま残る）。
  consumeRawMarkdownSyntax(root)

  const text = domToPlainText(root)

  // コードブロックの範囲（入力中の閉じていないコードブロックを含む、findCodeBlockProtectedRanges
  // 参照）を先に確保し、引用の判定がコードブロックの中身まで誤って解釈しないようにする（例:
  // ```の中にgit diff風の「> 」行がある場合。閉じていないコードブロックの中身を保護しないと、
  // 閉じる```を打つ前に中の「> 」行が先に引用として確定してしまう不具合があった——実機
  // Playwright検証で発見）。この時点ではconsumeCodeBlockMatchesがまだ走っていないため、```
  // マーカーはまだ生テキストのまま（collectRawMarkdownMatchesの重なり判定により上の
  // consumeRawMarkdownSyntaxからは保護されている）で、正しく検出できる。
  const codeBlockRanges = findCodeBlockProtectedRanges(text)

  // 引用（行頭「> 」の連続行）・箇条書き（行頭「- 」の連続行）を処理する。行単位のブロック
  // 構造のため、文字位置ベースのconsumeRawMarkdownSyntaxとは別立てで扱う。1行が両方の
  // プレフィックスに同時にマッチすることは無いため範囲は重ならないが、どちらも「マーカーを
  // 消して文字数を縮める」処理のため、開始位置の降順（後の範囲から）でまとめて処理しないと、
  // 先に処理した範囲より前方のオフセットが崩れる（consumeRawMarkdownSyntax等と同じ理由）。
  const quoteRanges = collectQuoteRanges(text, codeBlockRanges)
  const bulletRanges = collectBulletRanges(text, codeBlockRanges)
  const blockRanges = [
    ...quoteRanges.map((r) => ({ ...r, kind: 'quote' as const })),
    ...bulletRanges.map((r) => ({ ...r, kind: 'list' as const })),
  ].sort((a, b) => b.start - a.start)
  for (const r of blockRanges) {
    if (r.kind === 'quote') wrapQuoteRange(root, r)
    else wrapBulletRange(root, r)
  }

  // コードブロックは最後に処理する（引用の検出がまだ生の```マーカーを必要とするため）。
  consumeCodeBlockMatches(root)

  root.normalize()
  if (useMarkerBasedRestore) {
    const restored = restoreSelectionFromMarkers(root, hasRange)
    if (!restored) stripSelectionMarkersFromDom(root)
  } else if (preserved) {
    setSelectionOffsets(root, preserved.start, preserved.end)
  }
}

// 書式トグルボタン（太字・斜体・下線・取り消し線、ユーザーからの明示的な要望）。以下はDOM
// 構造を直接組み立てる関数群（本ファイル前方の書式セクションの冒頭コメント参照）。

export function computeElementOffset(root: HTMLElement, el: Element): { start: number; end: number } {
  const parent = el.parentNode as Node
  const idx = indexOfChild(el)
  const start = domPositionToOffset(root, parent, idx)
  return { start, end: start + textLength(el) }
}

/** contentを指定した書式の並び（外側→内側の順）でネストしたDOM要素として包んだ結果を返す
 * （DOMには挿入しない、呼び出し元がinsertNode/insertBefore等で配置する）。formatsが空なら
 * contentをそのまま返す。 */
function buildFormattedNode(content: Node, formats: ToggleFormatKind[]): Node {
  let result = content
  for (const kind of [...formats].reverse()) {
    const def = FORMAT_ELEMENT[kind]
    const wrapper = document.createElement(def.tagName)
    wrapper.className = def.className
    wrapper.setAttribute(TOGGLE_FORMAT_ELEMENT_ATTR, kind)
    wrapper.appendChild(result)
    result = wrapper
  }
  return result
}

/** [start,end)を指定した書式の並び（外側→内側の順、Composer.tsx側のpendingFormats/
 * activeFormats配列と同じ規約）でネストした実DOM要素として直接ラップする。マーカー文字は
 * 一切経由しない。Composer.tsxのmaterializePendingFormats（ボタンで保留していた書式を、実際に
 * 入力された文字の周りへ初めて構造化する処理）から使う。rootはHTMLElement・DocumentFragment
 * のどちらでもよい。 */
export function wrapRangeInFormats(root: Node, start: number, end: number, formats: ToggleFormatKind[]): void {
  if (start >= end || formats.length === 0) return
  const startPos = resolveOffset(root, start)
  const endPos = resolveOffset(root, end)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  const fragment = range.extractContents()
  range.insertNode(buildFormattedNode(fragment, formats))
}

/** [start,end)（複数行を含む選択範囲）をコードブロック（<pre data-block-format="codeblock">）で
 * 直接包む。手打ちの```検出（consumeCodeBlockMatches）と違い、マーカー文字を一切経由しない
 * ボタン駆動の経路のため、前後の"\n"を取り除く処理（stripOuterNewline）も不要——選択した内容を
 * そのまま包むだけで良い。Composer.tsxのwrapCode（複数行選択時）から使う。 */
export function wrapRangeAsCodeBlock(root: HTMLElement, start: number, end: number): void {
  if (start >= end) return
  const startPos = resolveOffset(root, start)
  const endPos = resolveOffset(root, end)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  const fragment = range.extractContents()
  const wrapper = document.createElement('pre')
  wrapper.setAttribute(BLOCK_FORMAT_ATTR, 'codeblock')
  wrapper.className = CODE_BLOCK_CLASSNAME
  wrapper.appendChild(fragment)
  range.insertNode(wrapper)
}

/** カーソル位置（プレーンテキストオフセット）を包む太字・斜体・下線・取り消し線の実要素を、
 * 内側から外側の順で返す（配列[0]が最も内側）。resolveOffsetでDOM位置を求め、そこから
 * parentElementをrootまで遡ってTOGGLE_FORMAT_ELEMENT_ATTR付きの要素だけを集める。 */
function getFormatElementChainAt(root: HTMLElement, cursor: number): HTMLElement[] {
  const pos = resolveOffset(root, cursor)
  let node: HTMLElement | null =
    pos.node.nodeType === Node.TEXT_NODE ? ((pos.node as Text).parentElement as HTMLElement | null) : (pos.node as HTMLElement)
  const chain: HTMLElement[] = []
  while (node && node !== root) {
    if (node.hasAttribute(TOGGLE_FORMAT_ELEMENT_ATTR)) chain.push(node)
    node = node.parentElement
  }
  return chain
}

function getFormatChainAt(root: HTMLElement, cursor: number): ToggleFormatKind[] {
  return getFormatElementChainAt(root, cursor).map((el) => el.getAttribute(TOGGLE_FORMAT_ELEMENT_ATTR) as ToggleFormatKind)
}

/** カーソル（選択なし）が現在activeFormatsの実要素チェーンの内部に位置しているか
 * （＝ボタンの押下状態がまだ有効かどうか）を判定する。selectionchangeとtoggleFormatAtCursorDom
 * の両方から使う。太字等が実DOM構造になったため、テキストの部分文字列比較ではなくDOM構造を
 * 直接調べる（偶然一致する文字列に惑わされない、より正確な判定になる）。 */
export function isCursorInsideActiveFormats(root: HTMLElement, cursor: number, activeFormats: ToggleFormatKind[]): boolean {
  if (activeFormats.length === 0) return false
  const chain = getFormatChainAt(root, cursor)
  if (chain.length !== activeFormats.length) return false
  for (let i = 0; i < chain.length; i++) {
    if (chain[i] !== activeFormats[activeFormats.length - 1 - i]) return false
  }
  return true
}

export interface ToggleFormatAtCursorDomResult {
  activeFormats: ToggleFormatKind[]
  /** 内側でない書式を解除した結果、残りの書式を保留（pendingFormats）へ回す必要がある場合に
   * 含める。それ以外は常に空配列。 */
  newlyPending: ToggleFormatKind[]
}

// この関数は「既にactiveFormats（＝実際に構造化済み、既に文字が入力済みの書式）に含まれる
// 書式をもう一度押して解除する」場合にのみ呼ばれる（Composer.tsxのtoggleFormatButton参照。
// まだ何も入力されていない新しい書式を押しただけの場合はこの関数を呼ばず、pendingFormatsの
// 切り替えだけで済ませる）。
//
// 退出点の作り方に既存のinsertTextAfterNode（本ファイル前方、メンションspanの境界問題向けに
// 実装済み）を使う理由: 数値オフセットをそのままsetSelectionOffsetsへ渡すだけでは不十分——
// resolveOffsetは「その位置より後に何も実体が無い」場合、要素の内側に留まる位置（例:
// {node: strong, offset: strong.childNodes.length}）を返す（lastPositionフォールバック）。
// これは通常は望ましい挙動だが、「書式を閉じた直後にカーソルを置く」場面では逆に危険で、
// 文書の絶対末尾で太字を解除した直後に何も実体を挿入しないと、次にタイプした文字がまだ
// <strong>の内側（＝その位置より後に何も無い）に入力されてしまう。
//
// バグ修正（実機Playwright検証で発見）: insertTextAfterNode(node, '')のように空文字列を
// 渡すと、挿入される退出点用のテキストノードは中身が空のまま残る。この直後に必ず呼ばれる
// afterMutate→refreshEditorHousekeeping→syncLiveFormattingの冒頭のroot.normalize()が
// 「空のテキストノードを除去する」仕様（Node.normalize()の定義どおり）のため、退出点その
// ものがユーザーが次の文字を打つ前に消えてしまい、Selectionが要素の内側（上記の危険な
// フォールバック位置）へ巻き戻ってしまっていた（実際に「太字を解除した直後に入力した文字が
// まだ太字のまま」「内側でない書式を解除した直後に入力した文字が古い入れ子構造の中に迷い込む」
// という2つの不具合として実機で確認した）。空文字列ではなく、既存のCARET_MARKER（ゼロ幅
// スペース、本ファイル前方でEnterキーの末尾改行キャレット問題向けに導入済み）を渡すことで、
// 中身が空でない（＝normalize()で除去されない）実在のテキストノードとして退出点を確実に
// 生き残らせる。次に実際の文字が入力された時点でhandleInputの冒頭のremoveCaretMarkerFromDom
// が速やかに片付け、domToPlainText/domToMarkdownの出力にも一切含まれない（既存の仕組みを
// そのまま再利用しているだけで、新しい特別扱いは増やしていない）。
export function toggleFormatAtCursorDom(
  root: HTMLElement,
  cursor: number,
  activeFormats: ToggleFormatKind[],
  kind: ToggleFormatKind,
): ToggleFormatAtCursorDomResult {
  if (!isCursorInsideActiveFormats(root, cursor, activeFormats)) {
    // カーソルが既にズレている状態で同じボタンをもう一度押した場合。DOMには一切触れず、
    // 記憶からその書式だけを取り除く（ボタンの見た目を正すだけ）。
    return { activeFormats: activeFormats.filter((f) => f !== kind), newlyPending: [] }
  }

  const elementChain = getFormatElementChainAt(root, cursor) // 内側→外側の順
  const idx = activeFormats.indexOf(kind)
  const isInnermost = idx === activeFormats.length - 1

  if (isInnermost) {
    const target = elementChain[0]
    if (textLength(target) === 0) {
      // 何も入力しないまま同じボタンをもう一度押して解除した場合。要素自体を削除する
      // （文字数は変化しないためSelectionは自然にその位置に残る）。
      target.remove()
      return { activeFormats: activeFormats.slice(0, -1), newlyPending: [] }
    }
    insertTextAfterNode(target, CARET_MARKER)
    return { activeFormats: activeFormats.slice(0, -1), newlyPending: [] }
  }

  // 内側でない書式を解除: 現在アクティブなチェーンの最も外側の要素を基準に、カーソルより
  // 後ろに既入力の内容が残っていればそれを切り出して残りの書式で再ラップし直し、外側要素の
  // 直後（Range.extractContents/insertNodeが境界点を正しく分割する既存の前提を利用）へ
  // 退出点を作る。残りの書式（例: bold+underline）は、その場に空の要素を作るのではなく
  // newlyPendingとして返し、実際に次の文字が入力されたときにComposer.tsx側の
  // materializePendingFormatsが改めてその場にラップする。
  const outer = elementChain[elementChain.length - 1]
  const outerRange = computeElementOffset(root, outer)
  const remaining = activeFormats.filter((f) => f !== kind)

  if (outerRange.end > cursor) {
    const startPos = resolveOffset(root, cursor)
    const endPos = resolveOffset(root, outerRange.end)
    const range = document.createRange()
    range.setStart(startPos.node, startPos.offset)
    range.setEnd(endPos.node, endPos.offset)
    const fragment = range.extractContents()
    const outerParent = outer.parentNode as Node
    const anchor = outer.nextSibling
    const node = remaining.length > 0 ? buildFormattedNode(fragment, remaining) : fragment
    outerParent.insertBefore(node, anchor)
    const lastInserted = anchor ? anchor.previousSibling : outerParent.lastChild
    insertTextAfterNode(lastInserted ?? outer, CARET_MARKER)
  } else {
    insertTextAfterNode(outer, CARET_MARKER)
  }
  return { activeFormats: [], newlyPending: remaining }
}

/** kindの実要素（TOGGLE_FORMAT_ELEMENT_ATTR="<kind>"）が[start,end)を（複数要素での分割
 * カバーも含めて）完全に覆っているか判定する。選択範囲トグルの「既に囲まれていれば外す」
 * 判定に使う。 */
export function isFullyWrapped(root: HTMLElement, start: number, end: number, kind: ToggleFormatKind): boolean {
  if (start >= end) return false
  const spans = Array.from(root.querySelectorAll<HTMLElement>(`[${TOGGLE_FORMAT_ELEMENT_ATTR}="${kind}"]`))
    .map((el) => computeElementOffset(root, el))
    .sort((a, b) => a.start - b.start)
  let covered = start
  for (const s of spans) {
    if (s.start > covered) break
    if (s.end > covered) covered = s.end
    if (covered >= end) return true
  }
  return covered >= end
}

/** 選択範囲がある状態で書式トグルボタンを押した結果を計算・適用する（既に完全にkindで
 * 囲まれていれば外す、そうでなければ丸ごと囲むトグル動作）。Range.extractContents/insertNodeが
 * 既存要素の境界を自然に分割するため、選択範囲が既存書式の境界を跨ぐケースも特別な処理は
 * 不要（部分的に重なった場合は新しい外側要素の内側に元の要素が入れ子で残るだけで、表示は
 * 変わらない）。マーカー文字を一切経由しないため、返す選択範囲は常に[start,end)のまま
 * （±prefix.lengthのような補正が不要——旧実装より単純になった点）。
 *
 * バグ修正（Playwrightでのインラインコード検証中に発見。太字等も含め全種で再現する
 * 一般的な不具合）: 「既に完全に囲まれている→外す」場合、以前はwrapする場合と同じく
 * Range.extractContents()で切り出してからunwrapMatchingしていたが、選択範囲の境界が
 * ちょうど対象要素の中身の先頭/末尾と一致する（例: 本文が丸ごと1つの<strong>だけで、
 * それを全選択して解除する）と、resolveOffsetは要素の「外側」ではなく「内側のテキスト
 * ノード」を指す位置を返す（resolveOffsetは未認識要素を常に子へ再帰するため）。この場合
 * Range自体が対象要素の内部に完全に収まってしまい、extractContentsが切り出すのは中身の
 * テキストだけで要素自体は含まれない——unwrapMatchingが空振りし、その後のinsertNodeが
 * 元の（空になった）要素の内側へテキストを戻してしまうため、見た目上「解除されない」
 * 不具合が起きていた。解除する場合はRangeを経由せず、対象要素そのものを直接querySelectorAll
 * で見つけて解除する（要素の存在そのものに依存するため、この境界のあいまいさの影響を
 * 受けない）。 */
export function toggleFormatOnSelectionDom(
  root: HTMLElement,
  start: number,
  end: number,
  kind: ToggleFormatKind,
): { selectionStart: number; selectionEnd: number } {
  if (start >= end) return { selectionStart: start, selectionEnd: end }
  if (isFullyWrapped(root, start, end, kind)) {
    const targets = Array.from(root.querySelectorAll<HTMLElement>(`[${TOGGLE_FORMAT_ELEMENT_ATTR}="${kind}"]`)).filter((el) => {
      const r = computeElementOffset(root, el)
      return r.start < end && start < r.end
    })
    for (const el of targets) {
      const parent = el.parentNode
      if (!parent) continue
      while (el.firstChild) parent.insertBefore(el.firstChild, el)
      parent.removeChild(el)
    }
    root.normalize()
    return { selectionStart: start, selectionEnd: end }
  }
  const startPos = resolveOffset(root, start)
  const endPos = resolveOffset(root, end)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  const fragment = range.extractContents()
  range.insertNode(buildFormattedNode(fragment, [kind]))
  return { selectionStart: start, selectionEnd: end }
}

/** 1件の生Markdownマッチ（開始・終了記号を含む範囲）を破壊的に処理する: 記号を取り除き、
 * 残りを（入れ子の生Markdownも再帰的に処理して）実要素でラップする。異常構造の場合は部分
 * 破壊を避け、切り出した内容をそのまま戻す（consumeRawMarkdownSyntaxのみから使う）。 */
function consumeOneRawMatch(root: Node, match: LiveMatch): void {
  const { start, end, kind } = match
  if (kind === 'codeblock' || start >= end) return
  const startPos = resolveOffset(root, start)
  const endPos = resolveOffset(root, end)
  const range = document.createRange()
  range.setStart(startPos.node, startPos.offset)
  range.setEnd(endPos.node, endPos.offset)
  const fragment = range.extractContents()

  const { prefix, suffix } = TOGGLE_FORMAT_MARKERS[kind]
  // extractHiddenMarkerは本来「隠しマーカーspanを作る」関数だが、ここでは返り値のspanは
  // 捨てて「記号の文字を確実に切り落とす」副作用だけを再利用する（引用側の隠しマーカー
  // 方式とは異なり、この経路では記号を隠すのではなく消し去るため）。
  const leading = extractHiddenMarker(fragment, prefix.length, false)
  const trailing = leading ? extractHiddenMarker(fragment, suffix.length, true) : null
  if (!leading || !trailing) {
    range.insertNode(fragment)
    return
  }
  // コードの中身はMessageList.tsx側でさらに解釈されない（太字等が入れ子になっていても記号のまま
  // 表示される）ため、ここでも再帰的なネスト検出をスキップし中身をそのまま実要素に入れる。
  if (kind !== 'code') consumeRawMarkdownMatchesOnFragment(fragment)
  range.insertNode(buildFormattedNode(fragment, [kind]))
}

/** fragment（既に1マッチぶんとして抽出済みの中身）の中に、さらに別の生Markdownが入れ子に
 * なっていないかを調べ、あれば再帰的にconsumeOneRawMatchを適用する。 */
function consumeRawMarkdownMatchesOnFragment(fragment: DocumentFragment): void {
  const innerText = domToPlainText(fragment)
  if (!innerText) return
  const nested = [...collectRawMarkdownMatches(innerText)].sort((a, b) => b.start - a.start)
  for (const m of nested) consumeOneRawMatch(fragment, m)
}

function stripSelectionMarkersFromDom(root: HTMLElement): void {
  if (!root.textContent) return
  if (!root.textContent.includes(SELECTION_START_MARKER) && !root.textContent.includes(SELECTION_END_MARKER)) return
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node as Text
      if (t.data.includes(SELECTION_START_MARKER) || t.data.includes(SELECTION_END_MARKER)) {
        t.data = stripSelectionMarkers(t.data)
      }
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    for (const child of Array.from(node.childNodes)) walk(child)
  }
  for (const child of Array.from(root.childNodes)) walk(child)
}

function findMarkerNode(root: HTMLElement, marker: string): { node: Text; offset: number } | null {
  const walk = (node: Node): { node: Text; offset: number } | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const idx = (node as Text).data.indexOf(marker)
      return idx === -1 ? null : { node: node as Text, offset: idx }
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null
    for (const child of Array.from(node.childNodes)) {
      const found = walk(child)
      if (found) return found
    }
    return null
  }
  for (const child of Array.from(root.childNodes)) {
    const found = walk(child)
    if (found) return found
  }
  return null
}

// バグ修正（実機Playwright検証で発見。ユーザーからの報告「引用の中で手打ちの**bold**が
// 閉じた直後、続けて打った文字までbold扱いになってしまう」）: 目印文字の位置を数値オフセットで
// 記録し、処理完了後にfinalText.indexOf(...)で求めた数値オフセットをsetSelectionOffsets経由で
// 復元する実装だと、「閉じたばかりの実要素の直後」という境界でtoggleFormatAtCursorDomと全く
// 同じ問題（resolveOffsetが手前の要素の内側に留まる位置を返すバイアス、composerEditing.tsの
// toggleFormatAtCursorDomのコメント参照）が起きる——目印文字は復元の直前に取り除いてしまうため、
// 復元の瞬間には「ただの数値オフセット」に戻ってしまい、境界のあいまいさを一切解消できない。
// 目印文字のノード参照を直接見つけて、その場でdataから1文字だけ取り除きながらSelectionを
// 明示的に置き直す（数値オフセットのround-tripを一切経由しない）ことで、この問題を避ける。
//
// バグ修正（実機Playwright検証で発見、上と同じ根の問題）: 目印文字を単純に取り除く
// （data.slice等で1文字減らす）と、その目印1文字だけがテキストノードの全内容だった場合
// （閉じたばかりの実要素の直後で他に何も続いていない、まさに今回のケース）、除去後は
// 中身が空のテキストノードにSelectionが取り残される。空のテキストノードはtoggleFormatAtCursorDom
// のコメントで既に指摘した通りNode.normalize()で除去されてしまうため、次に実際の文字が
// 入力される前にこの退出点そのものが消え、Selectionが手前の要素の内側へ巻き戻ってしまう。
// 単純に取り除くのではなく、既存のCARET_MARKER（ゼロ幅スペース、改行キャレット問題向けに
// 導入済み）へ置き換える——中身が空でない実在のテキストノードとして退出点を確実に生き残らせ、
// 次に実際の文字が入力された時点でhandleInputの冒頭のremoveCaretMarkerFromDomが速やかに
// 片付ける（既存の仕組みをそのまま再利用するだけで、新しい特別扱いは増やしていない）。 */
function restoreSelectionFromMarkers(root: HTMLElement, hasRange: boolean): boolean {
  const startHit = findMarkerNode(root, SELECTION_START_MARKER)
  if (!startHit) return false
  const endHit = hasRange ? findMarkerNode(root, SELECTION_END_MARKER) : null

  // 終端側を先に置き換える（同じテキストノードに両方ある場合、終端側のオフセットは常に
  // 開始側以降にあるため、先に置き換えても開始側のオフセットには影響しない）。1文字→1文字の
  // 置き換えのため、いずれの場合もオフセットの数値は変化しない。
  if (endHit) {
    endHit.node.data = endHit.node.data.slice(0, endHit.offset) + CARET_MARKER + endHit.node.data.slice(endHit.offset + 1)
  }
  startHit.node.data = startHit.node.data.slice(0, startHit.offset) + CARET_MARKER + startHit.node.data.slice(startHit.offset + 1)

  // バグ修正（実機Playwright検証で発見、上と同じ根の問題）: Selectionをoffset（＝置き換えた
  // CARET_MARKER文字の手前）に置くと、ブラウザが「新しい入力の書式は直前の要素から継承する」
  // という自前のヒューリスティック（resolveOffsetとは無関係にブラウザ自身が持つ、キャレットが
  // 要素境界のどちら側にあるかで入力書式を決める挙動）により、次に入力した文字が閉じたばかりの
  // <strong>等の内側に吸い込まれてしまう。insertTextAfterNode（本ファイル前方）がoffsetでは
  // なくtextNode.length（＝挿入した文字の直後）にSelectionを置いているのと同じ理由・同じ規約
  // で、CARET_MARKER文字の直後（offset+1）に置く。 */
  const sel = window.getSelection()
  if (!sel) return true
  const range = document.createRange()
  range.setStart(startHit.node, startHit.offset + 1)
  range.setEnd(endHit ? endHit.node : startHit.node, endHit ? endHit.offset + 1 : startHit.offset + 1)
  sel.removeAllRanges()
  sel.addRange(range)
  return true
}

/** 手打ちの生Markdown（**word**等）を検出し、マーカー文字を削除して実要素（<strong>等）へ
 * 破壊的に変換する。エスケープ機構が無いMarkdown方言のため、ボタンを使わず直接手打ちした
 * 場合も送信後の見た目と食い違わないようにする（本ファイル前方の書式セクションの冒頭コメント
 * 参照）。syncLiveFormattingから毎回呼ばれる。
 *
 * 選択範囲の保存・復元はこの関数の責務ではない（呼び出し元のsyncLiveFormattingが、この関数を
 * 含む一連の変換全体を1つの目印文字ベースの保存・復元で包む。詳細はsyncLiveFormattingの
 * コメント参照——以前はこの関数単独で数値オフセットの保存・復元を行っていたが、直後に
 * syncLiveFormatting自身が行う別の保存・復元と二重になり、後者が「閉じたばかりの実要素の
 * 直後」という境界を数値オフセットのround-tripだけで復元しようとして同じ問題を再発させて
 * いた）。この関数はDOM/テキストの変換だけに専念する。 */
export function consumeRawMarkdownSyntax(root: HTMLElement): void {
  const text = domToPlainText(root)
  const matches = collectRawMarkdownMatches(text)
  if (matches.length === 0) return

  // 開始位置の降順で処理する（後の要素ほど前方。処理済みの要素より前方のオフセットは
  // 後続の処理に影響しない）。
  const sorted = [...matches].sort((a, b) => b.start - a.start)
  for (const m of sorted) consumeOneRawMatch(root, m)
  root.normalize()
}

/** fragmentの中身が"\n"で始まる/終わる場合、その1文字だけを取り除く（MessageList.tsxの
 * splitCodeBlocksが受信側で行う「```\nコード\n```と書いたときの見た目上の余白を除去する」
 * 処理と対になる——ここで同じだけ削っておくことで、投稿欄のライブ表示と送信後の表示が一致する。
 * domToMarkdownは逆に、コードブロックを直列化する際に必ず"\n"を1つずつ復元して包む）。 */
function stripOuterNewline(fragment: DocumentFragment): void {
  const text = domToPlainText(fragment)
  if (text.startsWith('\n')) extractHiddenMarker(fragment, 1, false)
  if (text.endsWith('\n') && text.length > 1) extractHiddenMarker(fragment, 1, true)
}

/** 手打ちの```コードブロック```を検出し、開始・終了の3連バッククォートを削除して
 * <pre data-block-format="codeblock">へ破壊的に変換する。中身はMessageList.tsx側でさらに
 * 解釈されない（太字等・インラインコードのネスト検出は行わない）ため、consumeOneRawMatchと
 * 違い再帰処理は無い。syncLiveFormattingから、引用の検出（collectQuoteRanges、コードブロックの
 * 範囲をgit diff風の「> 」誤検出から除外する必要がある）より後に呼ぶ。 */
function consumeCodeBlockMatches(root: HTMLElement): void {
  const text = domToPlainText(root)
  const matches = [...text.matchAll(RAW_CODE_BLOCK_REGEX)]
  if (matches.length === 0) return

  // 開始位置の降順で処理する（consumeRawMarkdownSyntaxと同じ理由）。
  const sorted = [...matches].sort((a, b) => (b.index ?? 0) - (a.index ?? 0))
  for (const m of sorted) {
    const start = m.index ?? 0
    const end = start + m[0].length
    if (start >= end) continue
    const startPos = resolveOffset(root, start)
    const endPos = resolveOffset(root, end)
    const range = document.createRange()
    range.setStart(startPos.node, startPos.offset)
    range.setEnd(endPos.node, endPos.offset)
    const fragment = range.extractContents()

    const leading = extractHiddenMarker(fragment, 3, false)
    const trailing = leading ? extractHiddenMarker(fragment, 3, true) : null
    if (!leading || !trailing) {
      range.insertNode(fragment)
      continue
    }
    stripOuterNewline(fragment)

    const wrapper = document.createElement('pre')
    wrapper.setAttribute(BLOCK_FORMAT_ATTR, 'codeblock')
    wrapper.className = CODE_BLOCK_CLASSNAME
    wrapper.appendChild(fragment)
    range.insertNode(wrapper)
  }
  root.normalize()
}
