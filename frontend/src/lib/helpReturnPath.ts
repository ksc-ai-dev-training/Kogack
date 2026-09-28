// 操作マニュアル画面（/help、HelpView.tsx）の「← 戻る」の戻り先（ユーザーからの明示的な要望
// 「操作マニュアルを表示した後に、操作マニュアルから戻るボタンを追加したい」、2026-09-28）。
// ブラウザの履歴を1つ戻る（navigate(-1)）方式にしないのは、マニュアル本体をiframeで表示しており、
// マニュアル内の目次・章リンクを押すたびにiframe側の移動がブラウザの履歴に積まれるため
// （戻っても同じマニュアル内の前の位置に戻るだけで、画面を抜けられない）。代わりにLayoutが
// /help以外の画面へ移るたびにその場所を覚えておき、「← 戻る」はそこへ移動する。
// 再読み込み等で覚えていない場合はワークスペース（/、最後に開いていたチャンネル）へ戻す。
let lastNonHelpPath: string | null = null

export function rememberNonHelpPath(path: string): void {
  lastNonHelpPath = path
}

export function helpReturnPath(): string {
  return lastNonHelpPath ?? '/'
}
