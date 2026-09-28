import { useLocation, useNavigate } from 'react-router'
import { helpReturnPath } from '../lib/helpReturnPath'

// 操作マニュアルのアプリ内表示（ユーザーからの明示的な要望「アプリ上で操作マニュアルを確認できる
// ようにしてほしい」、2026-09-28）。マニュアル本体はバックエンドが /manual/ で配信する
// docs/06_操作マニュアル.html の原本（backend/routers/manual.py）で、この画面はサイドバーを
// 残したままiframeで表示するだけにする（マニュアルをReactで作り直して二重管理しないため）。
// /help#sec5 のようにハッシュを付けて開くと、その章から表示する（チャンネルAIの回答末尾に
// 付くリンクがこの形。services/ai_agent.pyの_attach_manual_link参照）。
export default function HelpView() {
  const { hash } = useLocation()
  const navigate = useNavigate()
  const src = `/manual/${hash}`
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[52px] flex-none items-center gap-2.5 border-b border-line px-5">
        {/* マニュアルを開く直前にいた画面へ戻る（lib/helpReturnPath.ts。iframe内の移動が
            ブラウザの履歴に積まれるため、履歴を1つ戻る方式にはしていない） */}
        <button
          type="button"
          onClick={() => navigate(helpReturnPath())}
          className="rounded-md border border-line-strong px-2.5 py-1 text-[12px] font-semibold text-ink-muted hover:border-accent-600 hover:text-accent-700"
        >
          ← 戻る
        </button>
        <span className="text-[15px] font-bold text-ink">📖 操作マニュアル</span>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto text-[12px] text-accent-700 underline hover:text-accent-800"
        >
          新しいタブで開く
        </a>
      </div>
      {/* key={src}: 同じ画面のままハッシュだけ変わった場合（別の章へのリンクを続けて押した等）も
          iframeを作り直して、確実にその章へスクロールさせる */}
      <iframe key={src} src={src} title="操作マニュアル" className="min-h-0 w-full flex-1 border-0 bg-surface" />
    </div>
  )
}
