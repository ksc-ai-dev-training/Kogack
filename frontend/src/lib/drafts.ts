// メッセージ下書きの永続化（ユーザーからの明示的な要望「メッセージ入力欄に文章を入力してから
// 別のチャンネルやDMにいくと、それまで打ち込んでいた文章が消えてしまうのを直したい。それぞれの
// チャンネルやスレッドで下書きが残せるようにしたい」）。2026-09-14に`key={channelId}`等で
// Composerを会話切替のたびに確実に再マウントするよう修正した際、入力中の文章が「別の会話に誤って
// 残る」バグは直った副作用として「切り替えると消える」ようになっており、今回はその消えた内容を
// 会話ごとに復元できるようにする。スレッド幅・通知モード・UI拡大率と同じ「個人のブラウザ内の
// 状態でサーバー同期不要」という判断で、localStorageに単一のJSONオブジェクト（会話キー→本文）
// として保持する（個別キーで大量のlocalStorageエントリを作るより、下書きの有無を一覧するのが楽）。
// 会話キーの形式: チャンネルは`c:<channelId>`、DMは`d:<dmId>`、スレッドは`t:<messageId>`
// （T-05の主キーはチャンネル・DMをまたいで一意なため、スレッドはこれ1つで足りる）。
import type { MentionPayload } from '../types'

const STORAGE_KEY = 'kogack_drafts'
// 同一タブ内での下書きの有無変化をサイドバー等へ伝える自作イベント（localStorageの'storage'
// イベントは同一タブ内の変更では発火しないブラウザ仕様のため、別途必要）
const CHANGE_EVENT = 'kogack-drafts-changed'

export interface DraftPayload {
  body: string
  // バグ修正（ユーザーからの報告「メンションを指定した状態で他のチャンネルに移ってから戻ると、
  // 下書きの本文は残るがメンションした人の背景色（青）が消えている＝メンション機能も失われている」、
  // 2026-09-14）。当初はbody（本文の文字列）のみを保存・復元しており、Composer.tsxのmentions
  // state（本文中の「@氏名」のうちどれが実際の構造化メンションかを示す配列。ハイライト表示にも
  // 送信時にも使う）は再マウント時に常に空配列へリセットされていた。本文が「@氏名」という
  // "見た目だけ"のテキストとして復元される一方、メンションとしての実体（target_user_id等）が
  // 失われていたため、ハイライトが消え、実際に送信してもメンション通知が飛ばない状態になっていた
  mentions: MentionPayload[]
}

// 旧形式（本文の文字列のみ）との互換のため、読み込み時の値の型はどちらもありうる
type StoredEntry = DraftPayload | string
type DraftMap = Record<string, StoredEntry>

function readAll(): DraftMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as DraftMap) : {}
  } catch {
    // プライベートブラウジング等でlocalStorageが使えない環境では下書きの永続化自体を諦める
    return {}
  }
}

function normalize(entry: StoredEntry | undefined): DraftPayload {
  if (entry === undefined) return { body: '', mentions: [] }
  // 旧形式（本文の文字列のみ）で保存された下書きは、メンション情報こそ持たないが本文自体は
  // そのまま復元できる（このバグ修正より前に保存された下書きを失わせないため）
  if (typeof entry === 'string') return { body: entry, mentions: [] }
  return entry
}

function persist(map: DraftMap, notify: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 書き込みに失敗しても、このタブ内でのComposerの表示自体には影響しない（呼び出し元は
    // setState済みのbody/mentionsをそのまま使い続けられる）ため握りつぶす
  }
  // 下書きの「有無」（サイドバー・スレッド一覧のマーク対象）が変わったときだけ通知する。
  // 1文字入力するたびに全リスナーへ通知すると、サイドバー等が無駄に再レンダーし続けるため
  if (notify) window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function getDraft(key: string): DraftPayload {
  return normalize(readAll()[key])
}

export function setDraft(key: string, body: string, mentions: MentionPayload[] = []) {
  const map = readAll()
  const hadDraft = key in map
  if (body.trim() === '') {
    if (!hadDraft) return // 元々無かったなら何もしない（空文字での書き込み・通知を繰り返さない）
    delete map[key]
    persist(map, true)
    return
  }
  const existing = normalize(map[key])
  if (existing.body === body && JSON.stringify(existing.mentions) === JSON.stringify(mentions)) return
  map[key] = { body, mentions }
  persist(map, !hadDraft)
}

export function clearDraft(key: string) {
  setDraft(key, '')
}

/** サイドバー・スレッド一覧のマーク表示用。値そのものは使わず「このキーに下書きがあるか」だけを見る */
export function getDraftKeySet(): Set<string> {
  return new Set(Object.keys(readAll()))
}

/** 下書きの有無が変化した（自タブ内のCHANGE_EVENT・他タブでの変更を反映する'storage'の両方）ときに呼ばれる */
export function subscribeDrafts(callback: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}
