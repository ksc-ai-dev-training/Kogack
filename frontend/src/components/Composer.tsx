import { useEffect, useRef, useState } from 'react'
import { useToast } from './Toast'

const MIN_ROWS = 2
const MAX_ROWS = 10

// S-03・S-04共通の投稿欄（詳細設計書 画面設計11.3節）。呼び出し元はAPI呼び出し（A-11/A-14/A-19）
// とmutate()だけを担い、送信中状態・エラートーストはこちらで一元管理する。
export default function Composer({
  placeholder,
  onSend,
}: {
  placeholder: string
  onSend: (body: string) => Promise<void>
}) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const toast = useToast()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 3行目以降は入力に合わせて自動的に高さを広げ、10行を超えたらそれ以上は広げずスクロールにする
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    const style = window.getComputedStyle(el)
    const lineHeight = parseFloat(style.lineHeight) || 20
    const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    const minHeight = lineHeight * MIN_ROWS + paddingY
    const maxHeight = lineHeight * MAX_ROWS + paddingY

    el.style.height = 'auto'
    const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [body])

  const send = async () => {
    const text = body.trim()
    if (!text) return
    setSending(true)
    try {
      await onSend(text)
      setBody('')
    } catch (e) {
      toast(e instanceof Error ? e.message : '送信に失敗しました', 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="rounded-[10px] border border-line-strong px-3 py-2.5">
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
        placeholder={placeholder}
        rows={MIN_ROWS}
        maxLength={4000}
        className="w-full resize-none border-none text-[13px] text-ink outline-none placeholder:text-ink-subtle"
      />
      <div className="mt-2 flex items-center gap-0.5">
        <button
          type="button"
          disabled={sending || !body.trim()}
          onClick={send}
          className="ml-auto rounded-[7px] bg-accent-600 px-4 py-1.5 text-[12.5px] font-bold text-white disabled:opacity-40"
        >
          送信
        </button>
      </div>
    </div>
  )
}
