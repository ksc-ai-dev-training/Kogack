import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { Channel, Dm } from '../types'

const NOTIF_SUPPORTED = typeof window !== 'undefined' && 'Notification' in window

export type NotifPermission = 'unsupported' | 'default' | 'granted' | 'denied'

function currentPermission(): NotifPermission {
  if (!NOTIF_SUPPORTED) return 'unsupported'
  return Notification.permission as NotifPermission
}

// デスクトップ通知が実際に使える状態か（許可済み）。useChannels/useDmsが、通知を出すために
// タブ非表示中もポーリングを続ける（refreshWhenHidden）べきかの判定に使う。許可していない
// 利用者のバックグラウンドタブには余計なポーリング負荷をかけない（2026-09-10の負荷軽減方針）。
export function desktopNotificationsEnabled(): boolean {
  return NOTIF_SUPPORTED && Notification.permission === 'granted'
}

// ブラウザのデスクトップ通知（Web Notifications API）。プッシュ基盤（Service Worker + Web Push）は
// 持たず、既存のuseChannels/useDmsのポーリングが返すunread_countの増分を検知して、Kogackのタブが
// 非表示（他タブ・他アプリを見ている／最小化）のときだけOSの通知を出す簡易方式。
// ブラウザ・タブを完全に閉じている間は通知されない（Web Push未導入。CLAUDE.md 2026-09-10の方針）。
// リアルタイム配信自体は引き続きポーリングで、この通知もそのポーリング結果に相乗りするだけ。
export function useDesktopNotifications(joined: Channel[], dms: Dm[], meId: string | undefined) {
  const navigate = useNavigate()
  const [permission, setPermission] = useState<NotifPermission>(currentPermission)
  // 会話キー -> 直近に観測したunread_count。初回観測時はベースラインとして記録するだけ（通知しない）
  const seenRef = useRef<Map<string, number>>(new Map())
  const meIdRef = useRef(meId)

  const requestPermission = useCallback(async () => {
    if (!NOTIF_SUPPORTED) return
    try {
      const result = await Notification.requestPermission()
      setPermission(result as NotifPermission)
    } catch {
      // 一部の古いブラウザはPromiseを返さずコールバックのみ。そこまでは面倒を見ない
    }
  }, [])

  useEffect(() => {
    // アカウント切り替え（App.tsxのpendingSwitchガード）でmeが変わったらベースラインを作り直し、
    // 別ユーザーの会話一覧に元からある未読を「新着」と誤検知しないようにする
    if (meIdRef.current !== meId) {
      meIdRef.current = meId
      seenRef.current = new Map()
    }

    if (permission !== 'granted' || !NOTIF_SUPPORTED) return

    type Conv = { key: string; count: number; label: string; to: string }
    const convs: Conv[] = [
      ...joined.map((c) => ({
        key: `c:${c.id}`,
        count: c.unread_count ?? 0,
        label: `#${c.name}`,
        to: `/channels/${c.id}`,
      })),
      ...dms.map((d) => ({
        key: `d:${d.id}`,
        count: d.unread_count,
        label: d.is_self ? '自分（メモ）' : d.members.map((m) => m.name).join('、'),
        to: `/dms/${d.id}`,
      })),
    ]

    const seen = seenRef.current
    const increased: Conv[] = []
    for (const conv of convs) {
      const prev = seen.get(conv.key)
      // prevがundefined＝この会話を初めて観測したタイミング。ベースラインとして記録するだけで通知しない
      // （ページ読み込み直後に既存の未読ぶんがまとめて通知されるのを防ぐ）
      if (prev !== undefined && conv.count > prev) increased.push(conv)
      seen.set(conv.key, conv.count)
    }
    // 一覧から消えた会話（退出・削除）のキーは掃除する
    const liveKeys = new Set(convs.map((c) => c.key))
    for (const k of [...seen.keys()]) if (!liveKeys.has(k)) seen.delete(k)

    if (increased.length === 0) return
    // Kogackのタブを見ている＝操作中なので、未読バッジで十分。通知は出さない（Slackの既定と同じ）
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') return

    const fire = (title: string, body: string, tag: string, to: string) => {
      try {
        const n = new Notification(title, { body, tag })
        n.onclick = () => {
          window.focus()
          navigate(to)
          n.close()
        }
      } catch {
        // 通知生成に失敗しても致命的ではないため握りつぶす
      }
    }

    // バックグラウンドで長時間放置していた後などに多数の会話が一度に増えると通知が氾濫するため、
    // 4件以上はまとめて1通にする
    if (increased.length > 3) {
      fire('Kogack', `${increased.length}件のチャンネル・DMに新着メッセージがあります`, 'kogack-digest', '/')
      return
    }
    for (const conv of increased) {
      fire('新しいメッセージ', `${conv.label}（未読 ${conv.count} 件）`, `kogack-${conv.key}`, conv.to)
    }
  }, [joined, dms, meId, permission, navigate])

  return { permission, requestPermission, supported: NOTIF_SUPPORTED }
}
