import { Navigate, Route, Routes } from 'react-router'
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
// S-06は「チャンネル管理者」タブのみ（定期投稿・自動応答トリガー・AI設定7タブは未実装）。
// S-08は「利用者管理」タブのみ（ドキュメント参照範囲・AI利用状況・監査ログは未実装）。
export default function App() {
  const { me, isLoading } = useMe()

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
