// 最後に開いていたチャンネル（基本設計書3.1節「最後に開いていたチャンネルを表示」、
// 詳細設計書 画面設計のlocalStorageキー表 kogack-last-channel-id）。ワークスペース（/）を開いたとき
// （ログイン直後・管理コンソールの「← ワークスペースに戻る」等）にここへ戻す。従来は未実装のまま
// 常に参加中の先頭チャンネルへ移動しており、ユーザーから「管理コンソールに行った後にワークスペースに
// 戻るとチャンネルが一番上のやつに強制的に移行される」と報告された（2026-09-28）。
// サーバー同期不要の個人のUI設定のため、localStorageが使えない環境では何もしない（先頭チャンネルへ）。
const LAST_CHANNEL_STORAGE_KEY = 'kogack-last-channel-id'

export function readLastChannelId(): string | null {
  try {
    return localStorage.getItem(LAST_CHANNEL_STORAGE_KEY)
  } catch {
    return null
  }
}

export function saveLastChannelId(channelId: string): void {
  try {
    localStorage.setItem(LAST_CHANNEL_STORAGE_KEY, channelId)
  } catch {
    // noop（プライベートブラウジング等でlocalStorageが使えない場合）
  }
}
