import { useEffect, useState } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { mutate as mutateAll } from 'swr'
import { useMe } from './hooks/useMe'
import { useChannels } from './hooks/useChannels'
import Layout from './components/Layout'
import Login from './pages/Login'
import ChannelView from './pages/ChannelView'
import ChannelSettings from './pages/ChannelSettings'
import DmView from './pages/DmView'
import SearchView from './pages/SearchView'
import AdminConsole from './pages/AdminConsole'

// ルーティング・認証ガード（詳細設計書 総論5.1節・5.9節、画面設計11.3節）。
// このスライスはS-01ログイン＋S-02サイドバー＋S-03チャンネル会話＋DM＋S-04スレッド表示＋S-05横断検索＋S-06チャンネル設定＋S-08管理コンソール。
// S-05はメッセージ検索のみ（F-42モディファイアUI・ファイル/ドキュメント検索は未実装）。
// S-06は4タブ（チャンネル管理者・基本設定・キャラクタ・振る舞い定義）のみ（定期投稿・自動応答トリガー・
// 参照ドキュメント範囲・スキル・反応モード・自動対応範囲の6タブは未実装）。
// S-08は「利用者管理」タブのみ（ドキュメント参照範囲・AI利用状況・監査ログは未実装）。
export default function App() {
  const { me, isLoading } = useMe()
  const currentId = me?.id ?? null

  // 表示中のログインユーザーがアプリ実行中に切り替わったら、安全な起点（/）へ強制的に戻す
  // （ユーザーからの報告：あるユーザーがチャンネル会話を開いたまま、ログイン・ログアウトの
  // ボタンを経由しないセッション切り替え（複数タブ・別ブラウザでの再ログイン・dev-loginの
  // API直接呼び出し等）が起きると、そのタブは直前のユーザーが見ていたURLをそのまま新しい
  // ユーザーの画面として描画してしまい、非公開チャンネルであれば存在まで意図せず開示していた）。
  // ログイン・ログアウトの各ボタン自体は既にnavigate()で対応済みだが、それらを経由しない経路は
  // 保護されていなかった。useEffectでnavigate()を呼ぶ実装は、ChannelView等が新しいユーザーの
  // 権限で一度マウントされてしまってから遅れて是正する形になり、他のフックの再検証と競合すると
  // 是正が効かないことがあったため、レンダー中にstateを調整するReact公式パターンへ変更し、
  // 「新しいユーザーでChannelView等が一度も描画されない」ようにした（useUnreadDivider.tsと同じ手法）。
  const [lastUserId, setLastUserId] = useState<string | null | undefined>(undefined)
  const [pendingSwitch, setPendingSwitch] = useState(false)
  if (!isLoading && lastUserId !== currentId) {
    if (lastUserId !== undefined && currentId !== null) {
      setPendingSwitch(true)
    }
    setLastUserId(currentId)
  }
  // pendingSwitchは<Navigate>を一度描画したら消費済みとして戻す（次のレンダーでは通常どおりに戻す）。
  // レンダー中に消費すると<Navigate>自体が描画されないままリセットされてしまうため、
  // ここはコミット後に実行されるuseEffectで行う。あわせてSWRの全キャッシュを再取得する
  // （ユーザーからの報告：DM相手一覧等サイドバーの表示にも同じ問題があり、切り替え後
  // 数秒間（各フックのポーリング間隔に依存）は直前のユーザーのDM相手がサイドバーに残っていた。
  // SWRのキャッシュキーはURLのみでユーザーを問わないため、Layoutが再マウントされても
  // useDms()等は次の自然な再検証まで古いデータを表示し続けてしまう。ここで明示的に
  // 全キャッシュを再取得することで、切り替わった直後から新しいユーザーのデータに揃える）
  useEffect(() => {
    if (pendingSwitch) {
      setPendingSwitch(false)
      mutateAll(() => true, undefined, { revalidate: true })
    }
  }, [pendingSwitch])

  if (isLoading) {
    return <div className="p-8 text-center text-sm text-ink-subtle">読み込み中...</div>
  }

  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  if (pendingSwitch) {
    // 直前に表示していたユーザーとは異なるユーザーに切り替わった直後の1回だけここを通る。
    // ChannelView等のルート要素を一切描画せずに/へ逃がすことで、新しいユーザーの権限で
    // 古いURL（他人のチャンネル等）が一瞬でも描画されないようにする
    return <Navigate to="/" replace />
  }

  return (
    <Layout me={me}>
      <Routes>
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="/" element={<Home />} />
        <Route path="/channels/:channelId" element={<ChannelView />} />
        <Route path="/channels/:channelId/settings" element={<ChannelSettings />} />
        <Route path="/dms/:dmId" element={<DmView />} />
        <Route path="/search" element={<SearchView />} />
        <Route path="/admin" element={<AdminConsole />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}

// ログイン直後の初期表示。最後に開いていたチャンネル（次スライスでlocalStorage対応）が
// 無い間は、参加中の最初のチャンネルへ誘導する（基本設計書3.1節「最後に開いていたチャンネルを表示」の
// 簡易版。画面設計11.5節「設計判断」で確定する最終仕様は次スライスで実装する）。
function Home() {
  const { joined, isLoading } = useChannels()
  if (isLoading) {
    return <div className="p-8 text-center text-sm text-ink-subtle">読み込み中...</div>
  }
  if (joined.length > 0) {
    return <Navigate to={`/channels/${joined[0].id}`} replace />
  }
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-ink-subtle">
        参加中のチャンネルがありません。左のサイドバーの「＋」からチャンネルに参加・作成してください。
      </p>
    </div>
  )
}
