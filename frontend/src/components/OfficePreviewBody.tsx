// 参照ドキュメントのOffice形式（Word・PowerPoint・Excel）プレビュー本文（2026-10-01）。
// バックエンド（services/office_preview.py）が
// 本文を見出し・段落・箇条書き・表のブロック列のJSONへ変換して返し、ここでReactのテキストとして描画する
// （文書内のHTML・リンク等はブラウザに解釈させない）。S-08管理コンソールのDocPreviewModalと、チャット上の
// 引用（citation）プレビューのCitationPreviewModal（MessageList.tsx）で共有する
export type OfficeBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list_item'; text: string }
  // has_header: PowerPointのグラフから取り出した表（1行目が必ず見出し）。表示は通常の表と同じ
  | { type: 'table'; rows: { text: string; span: number }[][]; has_header?: boolean }
export type OfficePreview = { blocks: OfficeBlock[]; truncated: boolean }

const DOCX_HEADING_CLASS = ['', 'text-[18px]', 'text-[16px]', 'text-[14.5px]', 'text-[13.5px]']

export default function OfficePreviewBody({ preview }: { preview: OfficePreview }) {
  if (preview.blocks.length === 0) {
    return <p className="text-[12.5px] text-ink-subtle">本文がありません。</p>
  }
  return (
    <div className="rounded-md border border-line bg-surface px-6 py-5 text-[13px] leading-[1.75] text-ink">
      {preview.blocks.map((b, i) => {
        if (b.type === 'heading') {
          return (
            <div key={i} className={`mb-2 mt-4 font-bold first:mt-0 ${DOCX_HEADING_CLASS[b.level] ?? 'text-[13.5px]'}`}>
              {b.text}
            </div>
          )
        }
        if (b.type === 'list_item') {
          return (
            <div key={i} className="flex gap-2 pl-2">
              <span className="text-ink-subtle">・</span>
              <span className="whitespace-pre-wrap break-words">{b.text}</span>
            </div>
          )
        }
        if (b.type === 'table') {
          return (
            <div key={i} className="my-3 overflow-x-auto">
              <table className="border-collapse text-[12.5px]">
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={r} className={r === 0 ? 'bg-surface-subtle font-semibold' : ''}>
                      {row.map((cell, c) => (
                        <td key={c} colSpan={cell.span} className="whitespace-pre-wrap break-words border border-line px-2.5 py-1.5 align-top">
                          {cell.text}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        return b.text.trim() ? (
          <p key={i} className="mb-1.5 whitespace-pre-wrap break-words">
            {b.text}
          </p>
        ) : (
          <div key={i} className="h-3" />
        )
      })}
      {preview.truncated && (
        <p className="mt-4 text-[12px] text-ink-subtle">文書が長いため、途中までを表示しています。</p>
      )}
    </div>
  )
}
