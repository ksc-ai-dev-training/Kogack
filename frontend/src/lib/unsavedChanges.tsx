import { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import { useConfirm } from '../components/ui/ConfirmDialog'

// チャンネル設定などで、内容を変更してから「保存」ボタンを押さずに別の画面へ移動しようとした際に
// 確認ダイアログを出す仕組み（ユーザーからの明示的な要望、2026-09-11）。着手前に2案を提示し
// 「案A」で合意した:
//   案A（採用）: アプリ内のクリックによる画面遷移（サイドバーのリンク・「← チャンネルに戻る」等、
//     実際にLink/NavLinkをクリックして移動する経路）と、ブラウザのタブを閉じる/リロード/
//     URL直接入力（beforeunloadのブラウザ標準ダイアログ）をカバーする。
//   案B（見送り）: react-routerをデータルーターモードへ移行しuseBlockerでブラウザの「戻る」
//     ボタンも含め完全にブロックする。ルーティング構造の大きな変更を伴うため見送った。
// そのため**ブラウザの「戻る」「進む」ボタン（popstate）は対象外**という制約が残る
// （react-routerが宣言的モード＝<BrowserRouter>、main.tsx のため、データルーター専用の
// useBlockerが使えない。実際にnode_modules/react-router のuseBlocker実装がuseDataRouterContext
// を要求し、宣言的モードでは例外を投げることを確認済み）。
type Ctx = { dirtyRef: React.MutableRefObject<boolean> }
const UnsavedChangesContext = createContext<Ctx | null>(null)

export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const dirtyRef = useRef(false)
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      e.preventDefault()
      // Chromeはこの代入自体ではなくpreventDefault()の有無でダイアログの要否を判定するが、
      // 一部の古いブラウザ向けの仕様でもあるためreturnValueも設定しておく
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])
  // value={{ dirtyRef }} を毎レンダー新規オブジェクトにすると、このProvider自身が親
  // （ConfirmProvider、確認ダイアログの開閉のたびに再レンダーする）の再レンダーに巻き込まれる
  // たびにコンテキスト値の参照が変わり、下位のuseContext消費側（useReportDirty等）が
  // 無駄に再評価される。dirtyRef自体はuseRefで安定しているため、useMemoで包んで参照を固定する
  const value = useMemo(() => ({ dirtyRef }), [])
  return <UnsavedChangesContext.Provider value={value}>{children}</UnsavedChangesContext.Provider>
}

/** 保存前提の編集フォーム（ChannelSettings.tsxの各タブ等）が、レンダーのたびに現在の
 * 「未保存の変更があるか」を報告するためのフック。呼び出し側は現在値と保存済みの値
 * （baseline、保存成功時に更新する）を比較したbooleanを渡す。 */
export function useReportDirty(isDirty: boolean) {
  const ctx = useContext(UnsavedChangesContext)
  useEffect(() => {
    if (ctx) ctx.dirtyRef.current = isDirty
  }, [ctx, isDirty])
  useEffect(() => {
    // このタブ自体がアンマウントされた（＝画面遷移が実際に確定した後）ときだけフラグを戻す。
    // 上のeffectとは別にし、isDirtyが変わるたびにこのクリーンアップが動かないようにする
    return () => {
      if (ctx) ctx.dirtyRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx])
}

/** ナビゲーション要素（GuardedLink/GuardedNavLink）・ログアウトボタン等から呼ぶ。未保存の
 * 変更が無ければ即座にtrueを返し、あればユーザーに確認してその結果（trueなら移動してよい）
 * を返す。 */
export function useUnsavedChangesGuard() {
  const ctx = useContext(UnsavedChangesContext)
  const confirm = useConfirm()
  return async () => {
    if (!ctx?.dirtyRef.current) return true
    return confirm({
      title: '保存されていない変更があります',
      message: 'このまま移動すると、変更した内容は保存されずに失われます。移動してもよろしいですか？',
      confirmLabel: '保存せずに移動する',
      cancelLabel: 'このまま編集を続ける',
      danger: true,
    })
  }
}
