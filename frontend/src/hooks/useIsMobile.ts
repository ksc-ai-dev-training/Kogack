import { useEffect, useState } from 'react'

// スマートフォン表示（F-32 モバイル対応レイアウト）かどうか。Tailwindのmdブレークポイントに合わせ、
// 画面幅768px未満をスマホ扱いにする（CSS側の`md:`/`max-md:`と判定を一致させるため値を変えないこと）。
// 表示の出し分けは基本的にCSSの`max-md:`で行い、このフックはJS側でしか分岐できない箇所
// （/のリダイレクト抑止・スレッド幅のインラインstyle等）だけで使う
const QUERY = '(max-width: 767.98px)'

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(QUERY).matches)
  useEffect(() => {
    const mql = window.matchMedia(QUERY)
    const onChange = () => setIsMobile(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isMobile
}
