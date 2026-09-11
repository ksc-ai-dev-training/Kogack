// 投稿欄（Composer.tsx）で2026-09-10に実装した書式ボタン（太字・斜体・下線・取り消し線・
// コード・箇条書き）のテキスト操作アルゴリズムを、状態を持たない純粋関数として切り出したもの。
// 発言の編集（MessageList.tsxのインライン編集、ユーザーからの要望「編集の時にも通常のメッセージと
// 同じように書式のボタンを付けてほしい」、2026-09-11）でも同じ挙動を再現するために、Composer.tsx
// 内部に留めず共有モジュールへ出した（アルゴリズム自体は既に2回のバグ修正を経ており
// （空行での箇条書き挙動等）、複製すると同じ不具合を再発させるリスクがあるため、実装を1箇所に
// まとめて両方から呼ぶ構成にした。Composer.tsx自体は既存の動作確認済みコードを変更するリスクを
// 避けるため、あえてこの共有モジュールへの移行はしていない（意図的な重複の許容、force_remove_member
// と同じ考え方）。

export interface TextEditResult {
  body: string
  selStart: number
  selEnd: number
}

/** 選択範囲をprefix/suffixで囲む。選択が無ければカーソルをマーカーの間に置く。
 * 選択があった場合はマーカーを含めた範囲を選択し直す（続けて別の書式を重ねがけしやすいように） */
export function wrapSelectionText(body: string, start: number, end: number, prefix: string, suffix: string): TextEditResult {
  const before = body.slice(0, start)
  const selected = body.slice(start, end)
  const after = body.slice(end)
  const nextBody = before + prefix + selected + suffix + after
  if (selected) {
    return { body: nextBody, selStart: start, selEnd: start + prefix.length + selected.length + suffix.length }
  }
  const pos = start + prefix.length
  return { body: nextBody, selStart: pos, selEnd: pos }
}

/** 選択範囲に改行を含むかで自動的にインラインコード/コードブロックを切り替える */
export function wrapCodeText(body: string, start: number, end: number): TextEditResult {
  if (body.slice(start, end).includes('\n')) {
    return wrapSelectionText(body, start, end, '```\n', '\n```')
  }
  return wrapSelectionText(body, start, end, '`', '`')
}

/** 選択範囲を含む行全体を対象に行頭へ「- 」を付ける（既に全行付いていれば外すトグル動作）。
 * 複数行の選択に含まれる空行（段落の区切り）はそのまま維持するが、対象がその空行1行だけ
 * （何も入力していない行にカーソルがある状態）の場合は「- 」を付ける */
export function insertBulletListText(body: string, start: number, end: number): TextEditResult {
  const lineStart = body.lastIndexOf('\n', start - 1) + 1
  const nextNewline = body.indexOf('\n', end)
  const lineEnd = nextNewline === -1 ? body.length : nextNewline
  const lines = body.slice(lineStart, lineEnd).split('\n')
  const nonBlankLines = lines.filter((l) => l.trim() !== '')
  const allBulleted = nonBlankLines.length > 0 && nonBlankLines.every((l) => l.startsWith('- '))
  const nextLines = lines.map((l) => {
    if (l.trim() === '') return lines.length === 1 ? '- ' : l
    return allBulleted ? l.replace(/^- /, '') : (l.startsWith('- ') ? l : `- ${l}`)
  })
  const nextBlock = nextLines.join('\n')
  const nextBody = body.slice(0, lineStart) + nextBlock + body.slice(lineEnd)
  const pos = lineStart + nextBlock.length
  return { body: nextBody, selStart: pos, selEnd: pos }
}

/** 箇条書きの行でEnterを押した際の継続処理。対象外の行（箇条書きでない）ならnullを返す
 * （呼び出し側はnullのときpreventDefaultせず通常の改行に委ねる）。何も入力していない
 * 箇条書き行でEnterを押した場合はマーカーを外してリストから抜ける */
export function continueBulletOnEnter(body: string, cursor: number): TextEditResult | null {
  const lineStart = body.lastIndexOf('\n', cursor - 1) + 1
  const nextNewlineIdx = body.indexOf('\n', cursor)
  const lineEnd = nextNewlineIdx === -1 ? body.length : nextNewlineIdx
  const bulletMatch = /^- (.*)$/.exec(body.slice(lineStart, lineEnd))
  if (!bulletMatch) return null
  if (bulletMatch[1].trim() === '') {
    const nextBody = body.slice(0, lineStart) + body.slice(lineEnd)
    return { body: nextBody, selStart: lineStart, selEnd: lineStart }
  }
  const insertText = '\n- '
  const nextBody = body.slice(0, cursor) + insertText + body.slice(cursor)
  const pos = cursor + insertText.length
  return { body: nextBody, selStart: pos, selEnd: pos }
}
