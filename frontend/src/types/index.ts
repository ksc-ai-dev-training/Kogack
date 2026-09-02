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
  /** 呼び出し元が実際の参加者かどうか。システム管理者は非参加の非公開チャンネルでもA-06自体は
   * 取得できる（S-06用）ため、S-03（会話画面）側でこれを見て参加者以外を締め出す必要がある */
  is_member: boolean
}

export interface ChannelsResponse {
  joined: Channel[]
  joinable: Channel[]
}

/** T-08 channel_ai_settings（A-23〜A-27, A-45）。out_of_scope_policyはドキュメントQ&Aが未実装の
 * ためこのスライスでは編集UIを設けない（値はサーバー側の既定のまま） */
export interface AiSettings {
  channel_id: string
  is_ai_enabled: boolean
  persona_name: string | null
  persona_icon_url: string | null
  persona_tone: string | null
  behavior_prompt: string | null
  reaction_mode: 'mention_only' | 'proactive'
  out_of_scope_policy: 'strict' | 'general'
  folder_ids: string[]
  skills: Skill[]
  auto_response_rules: AutoResponseRule[]
  fallback_handoff_user_id: string | null
}

/** T-12 channel_auto_response_rules（A-31, F-16）。request_categoryはチャンネル管理者が
 * 自由に追加・削除できる（固定候補ではない） */
export interface AutoResponseRule {
  request_category: string
  response_level: 'auto' | 'confirm' | 'human'
}

/** T-11 channel_skills（A-28〜A-30, F-12） */
export interface Skill {
  id: string
  title: string
  instructions: string
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

/** F-07 ファイル共有（T-06 message_attachments） */
export interface MessageAttachment {
  id: string
  file_name: string
  byte_size: number
}

/** ComposerがA-21アップロード後に保持し、A-11/A-14/A-19の送信時にattachmentsとして渡す形
 * （MentionPayloadと同じ「先にアップロード→参照だけ投稿時に渡す」パターン） */
export interface AttachmentPayload {
  file_name: string
  byte_size: number
  storage_path: string
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
  /** F-07 ファイル共有。チャンネル・DMどちらの発言にも付く */
  attachments?: MessageAttachment[]
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

/** members には自分自身は含まれない（サイドバー・ヘッダー表示用に相手のみ解決済み）。
 * ただしis_self=true（F-05自分専用DM、メモ・下書き・To-do用途）の場合だけは例外で、
 * 除外すると空になってしまうためmembersに自分自身（1件）が入る */
export interface Dm {
  id: string
  members: DmMember[]
  is_self: boolean
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

/** type='message'|'file'はF-06/F-07で実装済み。type='document'はドキュメント根拠検索（層2）が
 * 未実装のため常に0件（documentのitemsが返ることは無い）。message_id/excerptはtype='message'限定、
 * attachment_id/file_name/byte_sizeはtype='file'限定で、それ以外は両方に共通のフィールド */
export interface SearchResultItem {
  type: 'message' | 'file' | 'document'
  message_id?: string
  attachment_id?: string
  file_name?: string
  byte_size?: number
  channel_id: string | null
  channel_name: string | null
  dm_id: string | null
  dm_label: string | null
  sender_display_name: string | null
  excerpt?: string
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

/** S-08利用者管理（A-36）。chadmin_channelsは参考表示のみ（変更はS-06から行う）だが、
 * 各チャンネルのidはS-06へのリンクを組み立てるために使う */
export interface AdminUser {
  id: string
  name: string
  email: string
  picture_url: string | null
  role: Role
  is_active: boolean
  last_login_at: string | null
  chadmin_channels: { id: string; name: string }[]
}

export interface AdminUsersResponse {
  items: AdminUser[]
}

/** F-22 参照ドキュメント範囲（T-09 doc_folders、S-08「ドキュメント参照範囲」タブ） */
export interface DocFolder {
  id: string
  drive_folder_id: string
  drive_folder_name: string
  added_by_name: string
  channel_count: number
  created_at: string
}

export interface DocFoldersResponse {
  items: DocFolder[]
}

/** F-29 AI利用状況・コスト（T-13 ai_usage_logs、S-08「AI利用状況・コスト」タブ） */
export interface UsageByChannel {
  channel_id: string
  channel_name: string | null
  call_count: number
  input_tokens: number
  output_tokens: number
  cost_yen: number
}

export interface UsageByUser {
  user_id: string
  user_name: string
  call_count: number
  input_tokens: number
  output_tokens: number
  cost_yen: number
}

/** T-14 ai_usage_limits。80%到達時の通知メール送信・応答停止は未実装（上限到達時の挙動は
 * 千田氏との別途協議事項のため、このスライスは設定の保存とused_pct表示のみ） */
export interface UsageLimit {
  monthly_limit_yen: number
  notify_threshold_pct: number
  notify_email: string
  used_pct: number
}

export interface UsageChannelLimit extends UsageLimit {
  channel_id: string
  channel_name: string | null
}

export interface UsageStats {
  month: string
  total_cost_yen: number
  total_call_count: number
  by_channel: UsageByChannel[]
  by_user: UsageByUser[]
  limits: {
    global: UsageLimit | null
    channels: UsageChannelLimit[]
  }
}

/** S-08「監査ログ」タブ（A-44、T-16）。ログイン・チャンネルAI設定変更の記録。
 * summaryは種類の説明のみで、変更後の実際の値・差分は含まない */
export interface AuditLogEntry {
  id: string
  event_type: 'login' | 'channel_ai_setting_change'
  actor_user_id: string
  actor_name: string
  target_channel_id: string | null
  target_channel_name: string | null
  target_field: string | null
  summary: string
  created_at: string
}

export interface AuditLogsResponse {
  items: AuditLogEntry[]
  has_more: boolean
}
