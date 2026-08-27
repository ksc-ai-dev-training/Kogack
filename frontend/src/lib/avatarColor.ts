// 発言者・DM相手ごとに見た目上の色を固定するための簡易ハッシュ（画面モックアップの配色を再現）
const AVATAR_COLORS = ['#f97316', '#0ea5e9', '#a855f7', '#22c55e', '#ef4444', '#eab308', '#14b8a6', '#6366f1']

export function avatarColorFor(seed: string) {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) % AVATAR_COLORS.length
  return AVATAR_COLORS[hash]
}
