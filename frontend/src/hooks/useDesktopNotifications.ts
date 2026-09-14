import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { useNavigate } from 'react-router'
import { apiFetch } from '../lib/api'
import type { Channel, Dm } from '../types'

const NOTIF_SUPPORTED = typeof window !== 'undefined' && 'Notification' in window

export type NotifPermission = 'unsupported' | 'default' | 'granted' | 'denied'
// 'all' = 所属チャンネルの全新着＋DM、'mentions' = 自分へのメンションとDMのみ（Slackの既定に近い）、
// 'off' = 通知を一切出さない（2026-09-11追加。ブラウザの通知許可自体は維持したまま、アプリ側の
// 設定だけで止められるようにした。ユーザーからの要望「通知をオフにするオプションを追加」）
export type NotifMode = 'all' | 'mentions' | 'off'

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
// 持たず、既存のuseChannels/useDmsのポーリングが返すunread_count／unread_mention_countの増分を
// 検知して、Kogackのタブが非表示（他タブ・他アプリを見ている／最小化）のときだけOSの通知を出す。
// ブラウザ・タブを完全に閉じている間は通知されない（Web Push未導入。CLAUDE.md 2026-09-10の方針）。
// リアルタイム配信自体は引き続きポーリングで、この通知もそのポーリング結果に相乗りするだけ。
//
// mode='mentions'（既定は'all'）のときは、チャンネルの一般的な新着では通知せず、自分がF-41で
// メンションされた発言とDMの新着のみ通知する（DMは元々「自分宛て」なのでmodeに関わらず通知対象）。
// mode='off'のときは（ブラウザの許可自体は'granted'のままでも）一切通知を出さない。
//
// initialModeは`me.notif_mode`（A-04レスポンス）を渡す。従来はlocalStorageのみで管理していたが、
// ②（Web Push、services/push_sender.py）はサーバー自身が「誰に送るか」を判定する必要があるため
// サーバー側（DB）を正とする設定に変更した（2026-09-11）。setModeはローカルstateを即座に更新
// しつつ、A-62（PUT /api/users/me）で永続化する。
export function useDesktopNotifications(
  joined: Channel[], dms: Dm[], meId: string | undefined, initialMode: NotifMode,
  // ②（Web Push、usePushSubscription.ts）が実際に購読済みかどうか（バグ修正、2026-09-14）。
  // ①②は独立に動く設計だが、②はタブの表示状態に関わらず常に届くため、①が発火する条件
  // （タブが非表示/非フォーカス）は②の対象条件を包含してしまい、同じ新着に対して2つの
  // OS通知が二重に出てしまっていた（ユーザーからの報告「DMを送ると相手に通知が二つ送られて
  // くる」）。②が実際に有効なときは①の発火をスキップし、②が使えない環境（非対応ブラウザ・
  // VAPID未設定・購読失敗等）でのみ①がフォールバックとして働くようにする。Reactの再レンダーを
  // 起こす必要は無く「発火する瞬間の最新値」だけ見られればよいため、propではなくrefで受け取る
  pushActiveRef?: MutableRefObject<boolean>,
) {
  const navigate = useNavigate()
  const [permission, setPermission] = useState<NotifPermission>(currentPermission)
  const [mode, setModeState] = useState<NotifMode>(initialMode)
  // 会話キー -> 直近に観測した {未読件数, 自分へのメンション未読件数}。
  // 初回観測時はベースラインとして記録するだけ（通知しない）
  const seenRef = useRef<Map<string, { count: number; mentions: number }>>(new Map())
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

  const setMode = useCallback((m: NotifMode) => {
    setModeState(m)
    apiFetch('/api/users/me', { method: 'PUT', body: JSON.stringify({ notif_mode: m }) }).catch(() => {
      // 保存に失敗してもこのタブ内では選択どおり動く（サーバー側の設定は次回起動時まで古いまま
      // 残りうるが、②プッシュの対象判定がわずかにずれるだけで致命的ではない）
    })
  }, [])

  useEffect(() => {
    // アカウント切り替え（App.tsxのpendingSwitchガード）でmeが変わったらベースラインを作り直し、
    // 別ユーザーの会話一覧に元からある未読を「新着」と誤検知しないようにする
    if (meIdRef.current !== meId) {
      meIdRef.current = meId
      seenRef.current = new Map()
    }

    if (permission !== 'granted' || !NOTIF_SUPPORTED) return

    type Conv = {
      key: string
      count: number
      mentions: number
      label: string
      to: string
      isDm: boolean
      // チャンネルごとの通知設定（2026-09-11）。'default'以外なら全体設定（mode）より優先する
      // （services/push_sender.pyの実効設定計算と同じ考え方）。DMには今回の機能を対象外としたため
      // 常にmode（全体設定）をそのまま使う
      effectiveMode: NotifMode
    }
    const convs: Conv[] = [
      ...joined.map((c) => ({
        key: `c:${c.id}`,
        count: c.unread_count ?? 0,
        mentions: c.unread_mention_count ?? 0,
        label: `#${c.name}`,
        to: `/channels/${c.id}`,
        isDm: false,
        effectiveMode: c.notif_mode && c.notif_mode !== 'default' ? c.notif_mode : mode,
      })),
      ...dms.map((d) => ({
        key: `d:${d.id}`,
        count: d.unread_count,
        // DM本体は既にcountの増分で常時通知されるため「メンション」区別は本来不要だが、
        // スレッド返信限定で「自分の発言への返信」「スレッド内メンション」「自分が過去に返信した
        // ことのあるスレッドへの新着」を伝える必要がある（2026-09-14、ユーザーからの明示的な要望）。
        // DM本体分と重複しないようbackendのunread_mention_countはスレッド返信のみを対象にしている
        // （routers/dms.py参照）
        mentions: d.unread_mention_count ?? 0,
        label: d.is_self ? '自分（メモ）' : d.members.map((m) => m.name).join('、'),
        to: `/dms/${d.id}`,
        isDm: true,
        effectiveMode: mode,
      })),
    ]

    const seen = seenRef.current
    const mentionHits: Conv[] = []
    const messageHits: Conv[] = []
    for (const conv of convs) {
      const prev = seen.get(conv.key)
      seen.set(conv.key, { count: conv.count, mentions: conv.mentions })
      // prevがundefined＝この会話を初めて観測したタイミング。ベースライン記録のみで通知しない
      // （ページ読み込み直後に既存の未読ぶんがまとめて通知されるのを防ぐ）
      if (prev === undefined) continue
      // effectiveMode==='off'でも観測（ベースライン更新）自体は続ける。ここで丸ごとスキップせず
      // 継続すると、後で'all'/'mentions'に戻したときにオフだった間の未読が一気に「新着」扱いで
      // 通知されてしまう
      if (conv.effectiveMode === 'off') continue
      if (conv.mentions > prev.mentions) mentionHits.push(conv)
      else if (conv.count > prev.count && (conv.isDm || conv.effectiveMode === 'all')) messageHits.push(conv)
    }
    // 一覧から消えた会話（退出・削除）のキーは掃除する
    const liveKeys = new Set(convs.map((c) => c.key))
    for (const k of [...seen.keys()]) if (!liveKeys.has(k)) seen.delete(k)

    if (mentionHits.length === 0 && messageHits.length === 0) return
    // Kogackのタブを見ている＝操作中なので、未読バッジで十分。通知は出さない（Slackの既定と同じ）。
    // バグ修正（ユーザーからの質問「別ウィンドウや他アプリが前に出ていてKogackは後ろにあるが
    // 部分的に見えている場合はどうなるか」を経て、2026-09-14）: 当初はdocument.visibilityStateだけを
    // 見ていたが、これは「タブがそのウィンドウ内でアクティブか」「ウィンドウが最小化されていないか」
    // しか反映せず、ウィンドウがOSのフォーカスを失っている（＝他のウィンドウ/アプリが前面にあり
    // 実質的に見えていない）状態でも'visible'のままになる。document.hasFocus()（ウィンドウが実際に
    // フォーカスを持っているか）も条件に加えることで、「他アプリが前面にあってKogackの内容が
    // 見えていない」状態でも正しく通知が出るようにした
    const isActivelyViewed =
      typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()
    if (isActivelyViewed) return
    // ②（Web Push）が有効なら、そちらが同じ新着を届けるためここでは出さない（二重通知の防止）
    if (pushActiveRef?.current) return

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

    // メンションは埋もれさせたくないので、件数に関わらず常に会話ごとに個別通知する
    for (const conv of mentionHits) {
      fire('あなたへのメンション', conv.label, `kogack-m-${conv.key}`, conv.to)
    }
    // 一般の新着は、多数の会話が一度に増えたとき（長時間放置後など）は通知が氾濫するため4件以上で集約
    if (messageHits.length > 3) {
      fire('Kogack', `${messageHits.length}件のチャンネル・DMに新着メッセージがあります`, 'kogack-digest', '/')
    } else {
      for (const conv of messageHits) {
        fire('新しいメッセージ', `${conv.label}（未読 ${conv.count} 件）`, `kogack-${conv.key}`, conv.to)
      }
    }
  }, [joined, dms, meId, permission, mode, navigate])

  return { permission, requestPermission, mode, setMode, supported: NOTIF_SUPPORTED }
}
