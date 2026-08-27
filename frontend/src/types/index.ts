// APIレスポンス型定義（詳細設計書 API設計4章）。このスライスはA-01〜A-11の範囲まで。

export type Role = 'member' | 'admin'

export interface Me {
  id: string
  email: string
  name: string
  role: Role
  picture_url: string | null
}

/** 開発用ログイン（/api/auth/dev-users）で使う。設計書には無いローカル開発専用の型 */
export interface DevUser {
  email: string
  name: string
  role: Role
}

export interface Channel {
  id: string
  name: string
  topic: string | null
  is_public: boolean
  created_by: string
  created_at: string
  /** joined一覧にのみ含まれる（joinableには無い。未読バッジ用） */
  unread_count?: number
}

export interface ChannelDetail extends Channel {
  member_count: number
  is_channel_admin: boolean
}

export interface ChannelsResponse {
  joined: Channel[]
  joinable: Channel[]
}

export interface ChannelMember {
  id: string
  name: string
  email: string
  picture_url: string | null
  role: Role
  is_active: boolean
  is_channel_admin: boolean
  joined_at: string
}

export interface ChannelMembersResponse {
  items: ChannelMember[]
}

/** T-07 message_blocks（05-1詳細設計書DB設計3.7節）。このスライスで実際に作成されるのは
 * block_type='mention'のみ（citation/external_system/quote_reference/pending_actionはAIサポート未実装）。 */
export interface MentionPayload {
  target_user_id: string
  display_name_snapshot: string
}

export interface MessageBlock {
  block_type: string
  payload: MentionPayload | Record<string, unknown>
  sort_order: number
}

export interface Message {
  id: string
  channel_id?: string | null
  dm_id?: string | null
  thread_parent_id?: string | null
  sender_type: 'human' | 'ai' | 'bot'
  sender_user_id: string | null
  sender_name: string | null
  /** BOT/AI発言はsender_user_idが無いため常にnull（実写真を持たない） */
  sender_picture_url: string | null
  body: string
  generation_status: 'generating' | null
  /** 元発言のみに含まれる（S-04スレッド表示への導線。A-10/A-18）。返信自体には付かない */
  thread_reply_count?: number
  /** F-41 @メンション。DM発言は常に空配列（候補元のA-46がチャンネル専用のため） */
  blocks?: MessageBlock[]
  created_at: string
}

export interface MessagesResponse {
  items: Message[]
  has_more: boolean
}

export interface DmMember {
  id: string
  name: string
  picture_url: string | null
}

/** members には自分自身は含まれない（サイドバー・ヘッダー表示用に相手のみ解決済み） */
export interface Dm {
  id: string
  members: DmMember[]
  created_at: string
  unread_count: number
}

export interface DmsResponse {
  items: Dm[]
}

export interface UserSearchResult {
  id: string
  name: string
  email: string
  picture_url: string | null
  is_active: boolean
}

/** このスライスはtype='message'のみ実装（ファイル・ドキュメント根拠は未実装のため常に0件） */
export interface SearchResultItem {
  type: 'message' | 'file' | 'document'
  message_id: string
  channel_id: string | null
  channel_name: string | null
  dm_id: string | null
  dm_label: string | null
  sender_display_name: string | null
  excerpt: string
  posted_at: string
}

export interface SearchResponse {
  counts: { message: number; file: number; document: number }
  items: SearchResultItem[]
  page: number
}

/** A-67: 発言者・メンバーのプロフィール確認（F-40）。所属チャンネル等は含まない
 * （基本設計書5.21節「設計判断」） */
export interface UserProfile {
  id: string
  name: string
  email: string
  picture_url: string | null
  role: Role
}

/** S-08利用者管理（A-36）。chadmin_channelsは参考表示のみ（変更はS-06から行う） */
export interface AdminUser {
  id: string
  name: string
  email: string
  role: Role
  is_active: boolean
  last_login_at: string | null
  chadmin_channels: string[]
}

export interface AdminUsersResponse {
  items: AdminUser[]
}
