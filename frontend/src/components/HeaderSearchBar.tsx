import { useNavigate } from 'react-router'
import { useUnsavedChangesGuard } from '../lib/unsavedChanges'

// S-03/DM会話ヘッダーのタイトル右側に置く常時表示の検索欄（ユーザーからの明示的な要望
// 「検索バーの機能は完璧なので、場所をサイドバーじゃなくて、ヘッダーのチャンネルタイトルが
// 書いてある右側においてほしい」。2026-09-15にサイドバー上部へ実装したもの（当時の設計判断
// はCLAUDE.md参照）から移設し、コンポーネント自体はそのまま流用した）。フォーカスした瞬間に
// 実際の検索ページ（S-05 SearchView.tsx）へ遷移する設計・遷移先URLへのin/in_label（またはwith/
// with_label）付与・SearchView.tsx側の既存の状態復元ロジックをそのまま使う点は移設前と変わらない。
// 外側divにml-autoを持たせ、チャンネル名・説明文（いずれも可変長）に押し出されず常に
// ヘッダー右側の固定位置（所属メンバー等のボタン群の直前）に来るようにしている（ユーザーからの
// 報告「チャンネル名の長さやチャンネル説明文の有無で検索バーの位置が変わるのが見づらい」への
// 対応、2026-09-15）。幅はw-56(224px)からw-64(256px)へ拡大した（ユーザーからの要望「検索バーの
// 長さをもっと長くしてほしい（チャンネル説明文に影響を与えない範囲で）」）。実測（サイドバー
// 260px＋実際のヘッダー構成を再現したPlaywright検証、`npm run build`で実際に生成されたCSSを
// 都度読み込んで検証——Tailwindは実際にソースで使われているクラスしかCSSへ出力しないため、
// テストHTML側だけでクラス名を差し替えても正しく検証できない点に注意）で、1366px以上の
// ウィンドウ幅（サイドバー260pxを除いた本文領域が約1100px以上）では説明文（max-w-[220px]）の
// 表示幅に一切影響が無いことを確認済み。1280px幅（本文領域1020px）というよくあるノートPC解像度
// でのみ説明文がわずかに縮む（220px→189px。既存のw-56でも213pxへ縮んでおり元から起きていた現象
// で、w-64はこれをわずかに悪化させる程度に留まる）。w-72(288px)以上に広げると同じ1280px幅で
// 220px→164pxまで縮み体感できる悪化になるため採用しなかった。
//
// DM会話ヘッダーにも同じ検索欄を付けた（ユーザーからの明示的な要望「DMの画面のヘッダーにも、
// チャンネル会話と同じように…検索バーを付けて。検索バーをクリックするとwith:がデフォルト入力
// されるようにして」、2026-09-15）。modifier propで`in:`（チャンネル）/`with:`（DM相手）を切り替える
// ——with:はrouters/search.pyの_build_conditionsが「指定したuser_idが参加者のDM」で絞り込む
// person-basedな条件のため、グループDMでは相手の1人（DmView.tsx側で選んだ代表者）だけを渡す
// （既存のwith:モディファイアの設計自体がperson-based、conversation-basedではないため、この点は
// 新規に解決すべき課題ではなく既存の仕様にそのまま乗っている）
export default function HeaderSearchBar({
  modifier, id, label,
}: {
  /** 'in' = チャンネル会話（in:チャンネル名）、'with' = DM会話（with:相手の氏名） */
  modifier: 'in' | 'with'
  /** チャンネルid、またはDM相手（代表1名）のuser_id。未指定なら修飾語を付けずに/searchへ遷移する
   * （自分専用DM等、prefillする相手がいない場合） */
  id?: string
  label?: string
}) {
  const navigate = useNavigate()
  const guardNavigation = useUnsavedChangesGuard()

  const openSearch = async (e: React.FocusEvent<HTMLInputElement> | React.MouseEvent<HTMLInputElement>) => {
    e.currentTarget.blur()
    if (!(await guardNavigation())) return
    const params = new URLSearchParams()
    if (id && label) {
      params.set(modifier, id)
      params.set(`${modifier}_label`, label)
    }
    const qs = params.toString()
    navigate(qs ? `/search?${qs}` : '/search')
  }

  const placeholder = label ? (modifier === 'in' ? `#${label} を検索` : `${label} とのDMを検索`) : '検索'

  return (
    <div className="relative ml-auto w-64 flex-none">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] text-ink-subtle">
        🔍
      </span>
      <input
        type="text"
        readOnly
        onFocus={openSearch}
        onClick={openSearch}
        placeholder={placeholder}
        title="横断検索"
        className="w-full cursor-pointer rounded-md border border-line-strong bg-surface-subtle py-1 pl-7 pr-2.5 text-[12px] text-ink-muted outline-none placeholder:text-ink-subtle hover:border-accent-600 focus:border-accent-600 focus:ring-4 focus:ring-accent-50"
      />
    </div>
  )
}
