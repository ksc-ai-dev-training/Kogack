// 送信する本文の前後の空白を取り除く共通処理。以前はここに書式ボタン（太字・箇条書き等）の
// テキスト操作（記号を直接挿入する方式）もあり、発言の編集・定期投稿/自動応答トリガーの本文欄が
// 使っていたが、それらの入力欄が通常の投稿欄（Composer.tsx）そのものに置き換わったため削除した。

/** 前後の空白・空行を取り除く（.trim()相当）。ただし末尾が箇条書き/引用の「空項目」
 * （行頭の"- "/"> "だけで中身が無い行、黒点/縦線だけの行）の場合は、そのマーカー直後の
 * 半角スペース1文字を意図的な記法として残す。バグ修正（ユーザーからの報告「箇条書きの
 * 最後の行を黒点だけ（何も入力せず）にして送信すると、表示が黒点付きの空項目ではなく
 * 生の"- "という文字列になる」）: 送信直前の本文（Composer.tsxのdomToMarkdown）は空項目を"- "（末尾に半角スペース）として持つが、素朴な
 * .trim()は文字列全体の末尾の空白文字としてこの意図的なスペースまで削ってしまう。結果、
 * 送信される本文が"...\n-"（スペース無し）になり、MessageList.tsxの箇条書き判定（行頭"- "、
 * スペース必須）に一致せず、生の"-"がただの文章として表示されていた。Composer.tsxのsend()・
 * ChannelSettings.tsxの定期投稿/自動応答トリガーの保存で、素の.trim()の代わりにこちらを呼ぶ。 */
export function trimMessageBody(text: string): string {
  let end = text.length
  while (end > 0 && /\s/.test(text[end - 1])) {
    if (text[end - 1] === ' ' && (text[end - 2] === '-' || text[end - 2] === '>')) {
      const beforeMarker = text[end - 3]
      if (beforeMarker === undefined || beforeMarker === '\n') break
    }
    end--
  }
  let start = 0
  while (start < end && /\s/.test(text[start])) start++
  return text.slice(start, end)
}
