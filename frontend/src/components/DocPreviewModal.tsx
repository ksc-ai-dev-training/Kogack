import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import OfficePreviewBody, { type OfficePreview } from './OfficePreviewBody'
import { useOverlayClose } from '../hooks/useOverlayClose'

// 参照ドキュメントのアプリ内プレビュー。S-08管理コンソールの「ドキュメント参照範囲」タブと、S-06チャンネル設定の
// 「参照ドキュメント範囲」タブ（2026-10-01、ユーザーからの要望で追加）で共有する。以下は当初の経緯
// S-08「ドキュメント参照範囲」タブでのアプリ内プレビュー（ユーザーからの明示的な要望
// 「アプリ内で参照ドキュメントをプレビューする機能を付けられますか」、2026-09-17。
// 対象画面はS-08管理コンソールのみとする方針で確認済み）。対応形式の判定は
// MessageList.tsxのattachmentPreviewKind（F-07添付ファイルプレビュー、2026-09-11）と
// 同じ拡張子集合・同じ理由（SVGは意図的に除外）で、バックエンド側の判定
// （services/preview_kind.py、レスポンス生成はservices/doc_preview.py）とも揃えている。ファイル自体が別ドメイン
// （doc_foldersと message_attachments）のため、MessageList.tsx側のコンポーネントは
// 変更せずこちらに小さく複製する。
// Office形式（Word・PowerPoint・Excel、2026-10-01）の本文描画はcomponents/OfficePreviewBody.tsxを参照
// （チャット上の引用プレビューと共有）
export type DocPreviewKind = 'image' | 'pdf' | 'text' | 'office'
const DOC_PREVIEW_IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const DOC_PREVIEW_TEXT_EXT = new Set(['txt', 'md', 'csv', 'json', 'log'])
export function docPreviewKind(fileName: string): DocPreviewKind | null {
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
  if (DOC_PREVIEW_IMAGE_EXT.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (DOC_PREVIEW_TEXT_EXT.has(ext)) return 'text'
  if (ext === 'docx' || ext === 'pptx' || ext === 'xlsx') return 'office'
  return null
}

export default function DocPreviewModal({
  previewUrl,
  fileName,
  kind,
  onClose,
}: {
  // 権限の判定は画面ごとに異なるため、どのエンドポイントから取得するかは呼び出し元が渡す
  // （S-08: /api/admin/doc-folders/{id}/preview、S-06: /api/channels/{id}/doc-folders/{id}/preview）
  previewUrl: string
  fileName: string
  kind: DocPreviewKind
  onClose: () => void
}) {
  const overlayClose = useOverlayClose(onClose)
  const [text, setText] = useState<string | null>(null)
  const [textError, setTextError] = useState<string | null>(null)
  const [office, setOffice] = useState<OfficePreview | null>(null)

  useEffect(() => {
    if (kind !== 'text' && kind !== 'office') return
    let cancelled = false
    fetch(previewUrl, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(typeof body?.detail === 'string' ? body.detail : 'プレビューを取得できませんでした')
        }
        return kind === 'office' ? res.json() : res.text()
      })
      .then((t) => {
        if (cancelled) return
        if (kind === 'office') setOffice(t as OfficePreview)
        else setText(t as string)
      })
      .catch((e) => {
        if (!cancelled) setTextError(e instanceof Error ? e.message : 'プレビューを取得できませんでした')
      })
    return () => {
      cancelled = true
    }
  }, [kind, previewUrl])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,24,33,0.6)] p-6"
      {...overlayClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-[860px] flex-col overflow-hidden rounded-[14px] bg-surface shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-none items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{fileName}</span>
          <div className="flex flex-none items-center gap-2">
            {/* Wordはプレビュー用のJSONを返すため、新しいタブで開いても文書としては表示できない */}
            {kind !== 'office' && (
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-line-strong px-2.5 py-1 text-[12px] text-ink-muted hover:bg-surface-subtle"
              >
                新しいタブで開く
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              title="閉じる"
              className="rounded-md px-2 py-1 text-ink-subtle hover:bg-surface-muted"
            >
              ✕
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-surface-subtle p-3">
          {kind === 'image' && (
            <img src={previewUrl} alt={fileName} className="mx-auto max-h-[70vh] max-w-full object-contain" />
          )}
          {kind === 'pdf' && (
            <iframe
              src={previewUrl}
              title={fileName}
              className="h-[70vh] w-full rounded-md border border-line bg-surface"
            />
          )}
          {kind === 'text' &&
            (textError ? (
              <p className="text-[12.5px] text-danger-text">{textError}</p>
            ) : text === null ? (
              <p className="text-[12.5px] text-ink-subtle">読み込み中...</p>
            ) : (
              <pre className="whitespace-pre-wrap break-words rounded-md border border-line bg-surface p-3 text-[12.5px] leading-[1.6] text-ink">
                {text}
              </pre>
            ))}
          {kind === 'office' &&
            (textError ? (
              <p className="text-[12.5px] text-danger-text">{textError}</p>
            ) : office === null ? (
              <p className="text-[12.5px] text-ink-subtle">読み込み中...</p>
            ) : (
              <OfficePreviewBody preview={office} />
            ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
