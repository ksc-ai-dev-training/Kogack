import type { MouseEvent } from 'react'
import { apiFetch, ApiError } from '../lib/api'
import { useMe } from '../hooks/useMe'
import { useCustomEmoji } from '../hooks/useCustomEmoji'
import { useToast } from './Toast'
import { useConfirm } from './ui/ConfirmDialog'
import type { CustomEmoji } from '../types'

// 絵文字ピッカー内のカスタム絵文字タイル（ユーザーからの明示的な要望「カスタムスタンプの削除が
// できるようにしてほしい」）。MessageList.tsx（リアクション用EmojiGridPopover）・Composer.tsx
// （投稿欄の絵文字ピッカー）の両方で使う。削除できるのは作成者本人またはシステム管理者のみ
// （サーバー側のDELETE /api/custom-emoji/{id}と同じ条件。表示制御は補助で、認可はサーバーが行う）。
// 削除できる絵文字にだけ、カーソルを合わせたとき右上に「×」を出す。
// 選択の発火はonMouseDown（Composerは投稿欄のフォーカス・選択範囲を失わないよう
// preventDefaultする必要があるため）とし、×側はmousedownを止めて選択扱いにならないようにする。
export function CustomEmojiTile({ emoji, onSelect }: { emoji: CustomEmoji; onSelect: (shortcode: string) => void }) {
  const { me } = useMe()
  const { mutate } = useCustomEmoji()
  const toast = useToast()
  const confirm = useConfirm()
  const canDelete = !!me && (me.id === emoji.created_by || me.role === 'admin')

  const remove = async (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const ok = await confirm({
      title: 'カスタム絵文字を削除',
      message: `:${emoji.name}: を削除しますか？ 既に使われているリアクション・発言では画像が表示されなくなり、:${emoji.name}: という文字で表示されます。`,
      confirmLabel: '削除する',
      danger: true,
    })
    if (!ok) return
    try {
      await apiFetch(`/api/custom-emoji/${emoji.id}`, { method: 'DELETE' })
      await mutate()
      toast(`:${emoji.name}: を削除しました`)
    } catch (err) {
      toast(err instanceof ApiError ? err.message : '削除に失敗しました', 'error')
    }
  }

  return (
    <div className="group relative h-9 w-9">
      <button
        type="button"
        title={`:${emoji.name}:（${emoji.created_by_name}さんが追加）`}
        onMouseDown={(e) => {
          e.preventDefault()
          onSelect(`:${emoji.name}:`)
        }}
        className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-surface-muted"
      >
        <img src={emoji.image_url} alt={emoji.name} className="h-7 w-7 object-contain" />
      </button>
      {canDelete && (
        <button
          type="button"
          title={`:${emoji.name}: を削除`}
          aria-label={`:${emoji.name}: を削除`}
          onMouseDown={remove}
          className="absolute -right-0.5 -top-0.5 hidden h-4 w-4 items-center justify-center rounded-full bg-ink-subtle text-[10px] leading-none text-white hover:bg-danger-text group-hover:flex"
        >
          ×
        </button>
      )}
    </div>
  )
}
