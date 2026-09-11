import { useEffect, useRef } from 'react'
import { apiFetch } from '../lib/api'
import type { NotifPermission } from './useDesktopNotifications'

// pushManager.subscribe()のapplicationServerKeyはUint8Arrayを要求するため、サーバーから受け取る
// base64url文字列（padding無し）を変換する（Web Pushの定番実装、MDNのサンプルと同じ形）
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64Safe)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}

// デスクトップ通知②（Web Push、2026-09-11）。①（hooks/useDesktopNotifications.ts、タブが開いている
// 間のみ）が許可済みになったタイミングで、Service Worker（public/sw.js）を登録し、まだ購読して
// いなければVAPID公開鍵で購読、購読情報をサーバー（POST /api/push/subscribe）へ保存する。これにより
// タブ・ブラウザを閉じていてもプッシュが届くようになる。ブラウザが未対応、またはサーバー側で
// VAPID未設定（②が使えない）の場合は何もしない（①は引き続き動く）。
//
// 実機検証メモ: pushManager.subscribe()はブラウザから実際にGoogleのプッシュ配送基盤（Chromeは
// FCM）へ登録しに行く実ネットワーク通信のため、数秒〜十数秒かかることがある（実測で約15秒
// かかったケースを確認済み）。この遅延自体は正常な挙動で、ここでは何もしない（待つだけでよい）。
export function usePushSubscription(permission: NotifPermission) {
  const attemptedRef = useRef(false)

  useEffect(() => {
    if (permission !== 'granted') return
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
    if (attemptedRef.current) return
    attemptedRef.current = true

    void (async () => {
      try {
        const { configured, public_key: publicKey } = await apiFetch<{
          configured: boolean
          public_key: string | null
        }>('/api/push/public-key')
        if (!configured || !publicKey) return

        await navigator.serviceWorker.register('/sw.js')
        const registration = await navigator.serviceWorker.ready
        let subscription = await registration.pushManager.getSubscription()
        if (!subscription) {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            // 新しめのTS DOM型定義はBufferSourceにArrayBuffer限定を要求し、Uint8Arrayの汎用
            // ArrayBufferLikeバッキングと噛み合わないことがあるため明示キャストする（実行時は問題ない）
            applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
          })
        }
        const json = subscription.toJSON()
        if (!json.endpoint || !json.keys) return
        await apiFetch('/api/push/subscribe', {
          method: 'POST',
          body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
        })
      } catch {
        // Service Worker登録・購読・サーバーへの保存のいずれに失敗しても、①（タブが開いている間の
        // 通知）は引き続き動くため、ここでは静かに諦める（ユーザー操作を要求するほどの機能ではない）
      }
    })()
  }, [permission])
}
