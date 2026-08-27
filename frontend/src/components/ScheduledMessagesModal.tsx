import { useScheduledMessages } from '../hooks/useScheduledMessages'
import { useChannels } from '../hooks/useChannels'
import { useDms } from '../hooks/useDms'
import { apiFetch } from '../lib/api'
import { useToast } from './Toast'
import { useConfirm } from './ui/ConfirmDialog'
import type { ScheduledMessage } from '../types'

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

// 「明日 9:00 に送信予定」のような相対表記（画面モックアップ 補足04）。3日目以降は絶対日付にする
function formatScheduledAt(iso: string): string {
  const target = new Date(iso)
  const time = target.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  const dayDiff = Math.round((startOfDay(target).getTime() - startOfDay(new Date()).getTime()) / 86400000)
  if (dayDiff === 0) return `今日 ${time} に送信予定`
  if (dayDiff === 1) return `明日 ${time} に送信予定`
  if (dayDiff === 2) return `明後日 ${time} に送信予定`
  return `${target.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric' })} ${time} に送信予定`
}

// 補足04 予約中のメッセージ（F-35）。ヘッダーの予約中バッジ（Layout.tsx）から開く。
// A-51はpendingのみ返すため、ここに並ぶのは常にキャンセル可能な予約だけ。
export default function ScheduledMessagesModal({ onClose }: { onClose: () => void }) {
  const { items, mutate } = useScheduledMessages()
  const { joined } = useChannels()
  const { dms } = useDms()
  const confirm = useConfirm()
  const toast = useToast()

  // A-51はchannel_id/dm_idのみを返す（宛先名はフロントで既存のuseChannels/useDmsのキャッシュから
  // 解決する。他のバッジ・一覧系APIと同じ「軽量API＋フロント側で名前解決」の考え方）
  const destination = (item: ScheduledMessage) => {
    if (item.channel_id) {
      const c = joined.find((c) => c.id === item.channel_id)
      return { icon: c?.is_public === false ? '🔒' : '#', label: c?.name ?? '(不明なチャンネル)' }
    }
    const d = dms.find((d) => d.id === item.dm_id)
    const label = d ? d.members.map((m) => m.name).join('、') : '(不明な相手)'
    return { icon: '🔒', label: `DM: ${label}` }
  }

  const cancel = async (id: string) => {
    const ok = await confirm({
      title: '予約をキャンセル',
      message: 'この送信予約をキャンセルしますか？ 二度と送信されません。',
      confirmLabel: 'キャンセルする',
      danger: true,
    })
    if (!ok) return
    try {
      await apiFetch(`/api/scheduled-messages/${id}`, { method: 'DELETE' })
      await mutate()
      toast('予約をキャンセルしました')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'キャンセルに失敗しました', 'error')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(20,24,33,0.45)] p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-[480px] flex-col overflow-hidden rounded-[14px] bg-surface shadow-[0_24px_60px_rgba(16,24,40,0.28)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2.5 px-[22px] pt-4.5">
          <div className="flex-1">
            <h2 className="text-[15.5px] font-bold text-ink">予約中のメッセージ</h2>
            <div className="mt-0.5 text-[11.5px] text-ink-subtle">
              送信前の内容確認・キャンセルができます（自分が予約したものだけ表示）
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-ink-subtle hover:text-ink-muted">
            ✕
          </button>
        </div>

        <div className="overflow-y-auto px-2.5 pb-1 pt-3">
          {items.length === 0 && (
            <p className="px-3 py-10 text-center text-xs text-ink-subtle">予約中のメッセージはありません</p>
          )}
          {items.map((item) => {
            const dest = destination(item)
            return (
              <div key={item.id} className="my-1.5 rounded-[10px] border border-line px-3 py-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="flex min-w-0 items-center gap-1 text-[12.5px] font-bold text-ink">
                    <span className="flex-none text-ink-subtle">{dest.icon}</span>
                    <span className="truncate">{dest.label}</span>
                  </span>
                  <span className="ml-auto flex-none rounded-md bg-accent-50 px-2 py-0.5 text-[11px] font-semibold text-accent-700">
                    {formatScheduledAt(item.scheduled_at)}
                  </span>
                </div>
                <div className="line-clamp-2 text-[12.5px] leading-relaxed text-ink">{item.body}</div>
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => cancel(item.id)}
                    className="rounded-md border border-line-strong px-3 py-1 text-[11.5px] font-bold text-danger-text"
                  >
                    予約をキャンセル
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="border-t border-line px-[22px] py-3 text-[11px] leading-relaxed text-ink-subtle">
          指定した時刻になると自動的に送信され、通常のメッセージと同じ扱いになります。送信前ならいつでもキャンセルできます。一度送信されたメッセージはここから取り消せません（通常の削除操作を使ってください）。
        </div>
      </div>
    </div>
  )
}
