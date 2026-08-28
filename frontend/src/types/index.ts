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

/** T-08 channel_ai_settings（A-23〜A-26）。out_of_scope_policy/fallback_handoff_user_idは
 * ドキュメントQ&A・自動対応分類が未実装のためこのスライスでは編集UIを設けない（値はサーバー側の
 * 既定のまま）。reaction_modeも同様に常に'mention_only'（サーバー側の既定値をそのまま表示するのみ） */
export interface AiSettings {
  channel_id: string
  is_ai_enabled: boolean
  persona_name: string | null
  persona_icon_url: string | null
  persona_tone: string | null
  behavior_prompt: string | null
  reaction_mode: 'mention_only' | 'proactive'
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
  /** AI発言はペルソナアイコン、BOT発言（F-36/F-38）は送り主アイコン画像のスナップショット
   * （bot_icon_url優先。いずれも未設定ならnull） */
  sender_picture_url: string | null
  /** BOT発言（F-36/F-38）の絵文字アイコン。sender_picture_urlが無いときのフォールバック表示に使う。
   * AI・人間の発言、F-43システム通知では常にnull */
  bot_icon?: string | null
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

/** F-35 送信予約（T-18 scheduled_messages）。このスライスはpendingのみをA-51が返す
 * （補足04・ヘッダーバッジ共通、05-3画面設計11.4節） */
export interface ScheduledMessage {
  id: string
  channel_id: string | null
  dm_id: string | null
  thread_parent_id: string | null
  body: string
  scheduled_at: string
  status: 'pending' | 'sent' | 'cancelled'
}

export interface ScheduledMessagesResponse {
  items: ScheduledMessage[]
}

/** Composerが送信予約（A-50）を呼ぶ際の送信先。channel_id/dm_idはどちらか一方のみ、
 * thread_parent_idはスレッド返信時のみ指定する */
export interface ScheduleTarget {
  channel_id?: string
  dm_id?: string
  thread_parent_id?: string
}

/** F-36 定期投稿（T-19 recurring_posts、S-06「定期投稿」タブ） */
export interface RecurringPost {
  id: string
  channel_id: string
  body: string
  bot_display_name: string
  bot_icon: string | null
  bot_icon_url: string | null
  frequency: 'once' | 'daily' | 'weekly' | 'monthly'
  anchor_at: string
  next_run_at: string
  is_active: boolean
  last_sent_at: string | null
  created_at: string
}

export interface RecurringPostsResponse {
  items: RecurringPost[]
}

/** F-38 自動応答トリガー（T-21 trigger_rules、S-06「自動応答トリガー」タブ） */
export interface TriggerRule {
  id: string
  channel_id: string
  trigger_type: 'keyword' | 'emoji'
  trigger_value: string
  action_type: 'post_message'
  action_body: string
  bot_display_name: string
  bot_icon: string | null
  bot_icon_url: string | null
  is_active: boolean
  created_at: string
}

export interface TriggerRulesResponse {
  items: TriggerRule[]
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
