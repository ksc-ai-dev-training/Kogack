// デスクトップ通知②（Web Push、2026-09-11）。タブ・ブラウザを閉じていてもブラウザが裏で
// 常駐させるService Worker。フロント本体からはhooks/usePushSubscription.tsが登録する。
// ①（Web Notifications API、hooks/useDesktopNotifications.ts）とは別経路で、backend/services/
// push_sender.pyがVAPID署名付きの暗号化プッシュを送ってきたときにここでOS通知として表示する。

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    // JSONでないペイロードは無視して既定表示にフォールバックする
  }
  const title = data.title || 'Kogack'
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    // 同じtagの通知が連続で来たとき、スタックさせず最新のものに差し替える
    renotify: !!data.tag,
    data: { url: data.url || '/' },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

// 通知クリック時、既に開いているKogackのタブがあればそこへフォーカス＋遷移し、
// 無ければ新規タブを開く（ProfileCard等のポータルUIと同じ「既存の1箇所へ集約する」考え方）
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(url)
          return client.focus()
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url)
      return undefined
    }),
  )
})
