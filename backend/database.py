# asyncpg接続プール管理、SCHEMA定義（詳細設計書 DB設計 3章）
import os
from pathlib import Path

import asyncpg


def load_root_env() -> dict[str, str]:
    """リポジトリルートの .env（DB_PORT / BACKEND_PORT 等）を読む。環境変数が優先"""
    env: dict[str, str] = {}
    path = Path(__file__).resolve().parent.parent / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            env[key.strip()] = value.strip()
    return env


ROOT_ENV = load_root_env()

_db_port = os.environ.get("DB_PORT") or ROOT_ENV.get("DB_PORT", "55433")
DATABASE_URL = (
    os.environ.get("DATABASE_URL")
    or ROOT_ENV.get("DATABASE_URL")
    or f"postgresql://kogack:kogack@localhost:{_db_port}/kogack"
)

# 本番(Supabase)も含め、既定でSCHEMAを起動時に自動適用する(AUTO_MIGRATE既定値="1")。
# 2026-09-04: 本番のみ既定で無効にしていた旧実装が原因で、messages.is_summary列(2026-09-03追加)が
# Fly.io本番のSupabase DBへ反映されないまま残り、メッセージ一覧取得(A-10/A-18)が
# KeyError経由の500エラーになる事故が発生した(CLAUDE.md実装状況節に記録)。SCHEMAは
# CREATE TABLE IF NOT EXISTS・ADD COLUMN IF NOT EXISTS・制約追加はDO $$ ... EXCEPTION WHEN
# duplicate_object THEN NULL; END $$ でいずれも冪等に保たれているため、毎起動時に流しても
# 安全という前提で既定を反転した(起動のたびに冪等なSQLが1回余分に走る分だけコールドスタートが
# わずかに遅くなるが、スキーマ取りこぼしの再発を防ぐ方を優先する判断。ユーザー承認済み)。
# 明示的に無効化したい場合のみ AUTO_MIGRATE=0 を環境変数/.envで指定する。
APP_ENV = os.environ.get("APP_ENV") or ROOT_ENV.get("APP_ENV", "development")
AUTO_MIGRATE = (os.environ.get("AUTO_MIGRATE") or ROOT_ENV.get("AUTO_MIGRATE") or "1") == "1"

_pool: asyncpg.Pool | None = None

# T-01 usersに加え、S-02/S-03スライスでT-02/T-03/T-05を追加（詳細設計書 DB設計3.1・3.2・3.3・3.5節）。
# T-05はAI/BOT関連カラムも定義どおりの形で先に作っておく（未使用でもNULL許容のため実害はなく、
# CREATE TABLE IF NOT EXISTS は既存テーブルへの列追加を retrofit しないため、後からのALTER TABLEを避ける）。
SCHEMA = """
-- T-01 users
CREATE TABLE IF NOT EXISTS users (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email        TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL,
    picture_url  TEXT,
    role         TEXT NOT NULL DEFAULT 'member'
                 CHECK (role IN ('member', 'admin')),
    is_active    BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- S-08利用者管理の「最終ログイン」列用（05-3画面設計に記載済みだがDB/API側が未反映だった抜けをbackfill）
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- T-02 channels
CREATE TABLE IF NOT EXISTS channels (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    topic        TEXT,
    is_public    BOOLEAN NOT NULL DEFAULT true,
    created_by   BIGINT NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;

-- T-03 channel_members
CREATE TABLE IF NOT EXISTS channel_members (
    channel_id        BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_channel_admin  BOOLEAN NOT NULL DEFAULT false,
    joined_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);
ALTER TABLE channel_members ENABLE ROW LEVEL SECURITY;

-- T-05 messages（channel_id・dm_idの両方を使用。スレッド・AI/BOT関連カラムは以降のスライスで使う）
CREATE TABLE IF NOT EXISTS messages (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id         BIGINT REFERENCES channels(id) ON DELETE CASCADE,
    dm_id              BIGINT,
    thread_parent_id   BIGINT REFERENCES messages(id),
    sender_type        TEXT NOT NULL CHECK (sender_type IN ('human', 'ai', 'bot')),
    sender_user_id     BIGINT REFERENCES users(id),
    body               TEXT NOT NULL DEFAULT '',
    generation_status  TEXT CHECK (generation_status IN ('generating')),
    bot_display_name   TEXT,
    bot_icon           TEXT,
    bot_icon_url       TEXT,
    recurring_post_id  BIGINT,
    trigger_rule_id    BIGINT,
    deleted_at         TIMESTAMPTZ,
    deleted_by         BIGINT REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((channel_id IS NULL) <> (dm_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread_parent ON messages (thread_parent_id);
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
-- F-14 やりとりの要約で生成された発言かどうか（ユーザーからの要望。会話上で要約機能により
-- 作成された文章だと分かるようにするため）。要約はチャンネル本体の新規発言として投稿される場合、
-- thread_parent_idが通常のAIメンション応答と同じくNULLになり構造上区別できないため、専用の
-- フラグ列で明示する（services/ai_agent.start_summaryのみが true を立てる）
ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_summary BOOLEAN NOT NULL DEFAULT false;

-- S-05横断検索（A-20）用（詳細設計書 API設計6.2節）。日本語形態素解析は導入せずpg_trgmの部分一致でよいと判断
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_messages_body_trgm ON messages USING gin (body gin_trgm_ops);

-- T-04 direct_messages / T-17 direct_message_members（05-1_詳細設計書_DB設計.html 3.4・3.17節）
-- グループDM対応。参加者は開始時に固定（開始後の追加・削除は対象外）
CREATE TABLE IF NOT EXISTS direct_messages (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_by   BIGINT NOT NULL REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE direct_messages ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS direct_message_members (
    dm_id       BIGINT NOT NULL REFERENCES direct_messages(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (dm_id, user_id)
);
ALTER TABLE direct_message_members ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_messages_dm_created ON messages (dm_id, created_at);

-- messages.dm_idはT-05を先に作った際はdirect_messagesが未定義だったためFK無しの列だった。
-- 既存テーブルへのFK追加はCREATE TABLE IF NOT EXISTSでretrofitされないため、ここで明示的に付与する
DO $$ BEGIN
    ALTER TABLE messages ADD CONSTRAINT messages_dm_id_fkey FOREIGN KEY (dm_id) REFERENCES direct_messages(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- T-22 read_states: サイドバーの未読バッジ用（基本設計書4.2節「サイドバー: 未読バッジ」、
-- 05-1_詳細設計書_DB設計.html 3.22節）。メッセージ単位ではなく「最後に読んだ時刻」のみを保持する
-- 単純な方式（設計判断は基本設計書6.2節）。channel_id/dm_idはmessagesと同じCHECK制約パターン。
CREATE TABLE IF NOT EXISTS read_states (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id    BIGINT REFERENCES channels(id) ON DELETE CASCADE,
    dm_id         BIGINT REFERENCES direct_messages(id) ON DELETE CASCADE,
    last_read_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((channel_id IS NULL) <> (dm_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_read_states_channel ON read_states (user_id, channel_id) WHERE channel_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_read_states_dm ON read_states (user_id, dm_id) WHERE dm_id IS NOT NULL;
ALTER TABLE read_states ENABLE ROW LEVEL SECURITY;

-- T-06 message_attachments: 添付ファイル（F-07、05-1_詳細設計書_DB設計.html 3.6節）。message_idは
-- NOT NULLのため、A-21（アップロード）の時点ではこの行を作らず、ファイル実体だけをディスクへ保存する。
-- 実際にA-11/A-14/A-19が発言を作成する同一トランザクション内で、確定したmessage_idを添えてこの行を
-- 作成する（T-07 message_blocksのF-41メンションと同じ「発言確定後に紐づける」考え方。
-- attachments.pyのinsert_attachments/fetch_attachments_grouped参照）。
CREATE TABLE IF NOT EXISTS message_attachments (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id    BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    file_name     TEXT NOT NULL,
    byte_size     BIGINT NOT NULL,
    storage_path  TEXT NOT NULL,
    uploaded_by   BIGINT NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments (message_id);
ALTER TABLE message_attachments ENABLE ROW LEVEL SECURITY;

-- T-07 message_blocks: 発言内の構造化ブロック（05-1_詳細設計書_DB設計.html 3.7節）。
-- 種類ごとにテーブルを分けずblock_type＋JSONB payloadに集約する設計（基本設計書6.2節「設計判断」）。
-- このスライスではblock_type='mention'（F-41 @メンション）のみ実際に作成する。
-- citation/external_system/quote_reference/pending_actionはAIサポート未実装のため対象外。
CREATE TABLE IF NOT EXISTS message_blocks (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id   BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    block_type   TEXT NOT NULL
                 CHECK (block_type IN ('citation', 'external_system', 'quote_reference', 'pending_action', 'mention')),
    payload      JSONB NOT NULL,
    sort_order   INT NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_blocks_message ON message_blocks (message_id);
ALTER TABLE message_blocks ENABLE ROW LEVEL SECURITY;

-- T-18 scheduled_messages: 送信予約（F-35、05-1_詳細設計書_DB設計.html 3.13節）。channel_id/dm_idは
-- T-05と同じCHECK制約（いずれか一方）。pending行はservices/scheduled_dispatcher.pyが30秒間隔
-- ポーリングで検出し、通常投稿と同じ経路でmessagesへ発言化する（基本設計書5.15節）。専用ジョブ
-- キュー（Celery等）は導入せずFastAPI内蔵のasyncioタスクとする。単一インスタンス運用が前提で、
-- 複数インスタンスに水平スケールする場合はアトミックなUPDATE...RETURNINGへの変更が必要
-- （基本設計書10章「設計判断」。F-36定期投稿と同じ制約）。
-- @メンションの構造化（T-07 message_blocks）はmentions列（JSONB、MentionInput相当の配列）に
-- 予約時点の指定をそのまま保持し、発言化のタイミング（services/scheduled_dispatcher.py）で
-- insert_mention_blocksへ渡してT-07へ反映する（基本設計書6.2節「設計判断」）。ファイル添付との
-- 併用はこのスライスでは引き続き対象外（要件定義書3.2節）。
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id        BIGINT REFERENCES channels(id) ON DELETE CASCADE,
    dm_id             BIGINT REFERENCES direct_messages(id) ON DELETE CASCADE,
    thread_parent_id  BIGINT REFERENCES messages(id) ON DELETE CASCADE,
    sender_user_id    BIGINT NOT NULL REFERENCES users(id),
    body              TEXT NOT NULL,
    mentions          JSONB NOT NULL DEFAULT '[]'::jsonb,
    scheduled_at      TIMESTAMPTZ NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at           TIMESTAMPTZ,
    CHECK ((channel_id IS NULL) <> (dm_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_dispatch ON scheduled_messages (status, scheduled_at);
ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;
-- 予約送信でのメンション対応（上記コメント参照）を追加した際のbackfill
ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS mentions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- T-08 channel_ai_settings（チャンネルAI設定、05-1_詳細設計書_DB設計.html 3.8節）。
-- チャンネルAI応答生成（基本設計書8章、詳細設計書AIサポート10章）の初回スライス。
-- out_of_scope_policy・fallback_handoff_user_idは列としては用意するが、ドキュメントQ&A・
-- 自動対応範囲分類（層2/層3）が未実装のためAI応答生成のロジックからは未参照（services/ai_agent.py）。
CREATE TABLE IF NOT EXISTS channel_ai_settings (
    id                        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id                BIGINT NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
    is_ai_enabled             BOOLEAN NOT NULL DEFAULT true,
    persona_name              TEXT DEFAULT 'Kogack AI',
    persona_icon_url          TEXT,
    persona_tone              TEXT,
    behavior_prompt           TEXT DEFAULT '',
    reaction_mode             TEXT NOT NULL DEFAULT 'mention_only' CHECK (reaction_mode IN ('mention_only', 'proactive')),
    out_of_scope_policy       TEXT NOT NULL DEFAULT 'strict' CHECK (out_of_scope_policy IN ('strict', 'general')),
    fallback_handoff_user_id  BIGINT REFERENCES users(id),
    updated_by                BIGINT REFERENCES users(id),
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE channel_ai_settings ENABLE ROW LEVEL SECURITY;
-- persona_nameの既定値を「AI」から「Kogack AI」へ変更した際のbackfill（CREATE TABLE IF NOT EXISTSは
-- 既存DBのテーブルには効かないため、既存DBの以後のINSERT分にも新しい既定値を反映させる。
-- 既にAI発言済みの行のpersona_name自体の書き換えは対象外＝一度きりの手動UPDATEで対応する）
ALTER TABLE channel_ai_settings ALTER COLUMN persona_name SET DEFAULT 'Kogack AI';

-- T-13 ai_usage_logs（05-1_詳細設計書_DB設計.html 3.11節）。質問文・回答文そのものは記録しない
-- （発言本文はT-05に既に保存されているため。基本設計書8.6節）。dm_idはDMでのAI応答が未実装のため
-- 現状常にNULL。
CREATE TABLE IF NOT EXISTS ai_usage_logs (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id          BIGINT REFERENCES channels(id) ON DELETE CASCADE,
    dm_id               BIGINT REFERENCES direct_messages(id) ON DELETE CASCADE,
    requested_by        BIGINT NOT NULL REFERENCES users(id),
    model               TEXT NOT NULL,
    input_tokens        INT NOT NULL,
    output_tokens       INT NOT NULL,
    estimated_cost_yen  NUMERIC(10, 4) NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((channel_id IS NULL) <> (dm_id IS NULL))
);
ALTER TABLE ai_usage_logs ENABLE ROW LEVEL SECURITY;

-- T-14 ai_usage_limits（05-1_詳細設計書_DB設計.html 3.11節）。S-08「AI利用状況・コスト」タブの
-- 上限設定（A-43）用。scope='global'は最大1行、scope='channel'はchannel_idごとに最大1行に
-- 部分ユニークインデックスで制約する（PostgreSQLのON CONFLICT ... WHEREで洗い替えを行う）。
-- 80%到達時の通知メール送信・応答停止制御はこのスライスでは対象外（上限到達時の挙動は
-- 要件定義書8.2節のとおり千田氏との別途協議事項のため、設定の保存・使用率の表示のみ行う）。
CREATE TABLE IF NOT EXISTS ai_usage_limits (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope                  TEXT NOT NULL CHECK (scope IN ('global', 'channel')),
    channel_id             BIGINT REFERENCES channels(id) ON DELETE CASCADE,
    monthly_limit_yen      NUMERIC(10, 2) NOT NULL,
    notify_threshold_pct   INT NOT NULL DEFAULT 80,
    notify_email           TEXT NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (scope = 'channel' OR channel_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_limits_global ON ai_usage_limits (scope) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_usage_limits_channel ON ai_usage_limits (channel_id) WHERE scope = 'channel';
ALTER TABLE ai_usage_limits ENABLE ROW LEVEL SECURITY;

-- T-19 recurring_posts（定期投稿、F-36。05-1_詳細設計書_DB設計.html 3.14節）。
-- services/scheduled_dispatcher.pyが30秒間隔でnext_run_at<=now() AND is_active=trueの行を検出し、
-- T-05へsender_type='bot'の発言を1件作成する（F-35と同じディスパッチャ、専用ジョブキューは導入しない）。
-- 送信後、頻度に応じてnext_run_atを更新する（'once'はis_active=falseにする）。個人宛て複数可への
-- 対応は一度実装したが方針転換で対象外に戻した（要件定義書3.2節「対象外機能」、T-20が欠番の理由）。
CREATE TABLE IF NOT EXISTS recurring_posts (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id        BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_by        BIGINT NOT NULL REFERENCES users(id),
    body              TEXT NOT NULL,
    bot_display_name  TEXT NOT NULL,
    bot_icon          TEXT DEFAULT '📌',
    bot_icon_url      TEXT,
    frequency         TEXT NOT NULL CHECK (frequency IN ('once', 'daily', 'weekly', 'monthly')),
    anchor_at         TIMESTAMPTZ NOT NULL,
    next_run_at       TIMESTAMPTZ NOT NULL,
    is_active         BOOLEAN NOT NULL DEFAULT true,
    last_sent_at      TIMESTAMPTZ,
    updated_by        BIGINT REFERENCES users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recurring_posts_dispatch ON recurring_posts (is_active, next_run_at);
ALTER TABLE recurring_posts ENABLE ROW LEVEL SECURITY;

-- T-21 trigger_rules（自動応答トリガー、F-38。05-1_詳細設計書_DB設計.html 3.16節）。F-35/F-36の
-- 時刻ベースのディスパッチャとは異なり、A-11（メッセージ投稿）内で同期的に判定するイベント駆動方式
-- （services/trigger_matcher.py。基本設計書6.2節「設計判断」）。
CREATE TABLE IF NOT EXISTS trigger_rules (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id        BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_by        BIGINT NOT NULL REFERENCES users(id),
    trigger_type      TEXT NOT NULL CHECK (trigger_type IN ('keyword', 'emoji')),
    trigger_value     TEXT NOT NULL,
    action_type       TEXT NOT NULL DEFAULT 'post_message' CHECK (action_type IN ('post_message')),
    action_body       TEXT NOT NULL,
    bot_display_name  TEXT NOT NULL,
    bot_icon          TEXT DEFAULT '⚡',
    bot_icon_url      TEXT,
    is_active         BOOLEAN NOT NULL DEFAULT true,
    updated_by        BIGINT REFERENCES users(id),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trigger_rules_channel_active ON trigger_rules (channel_id, is_active);
ALTER TABLE trigger_rules ENABLE ROW LEVEL SECURITY;

-- messages.recurring_post_id/trigger_rule_idは、参照先（T-19/T-21）が無い時期にF-43実装時点で
-- 先に列だけ用意していたため、FK無しの列だった。既存テーブルへのFK追加はCREATE TABLE
-- IF NOT EXISTSでretrofitされないため、messages.dm_idと同じ要領でここで明示的に付与する。
DO $$ BEGIN
    ALTER TABLE messages ADD CONSTRAINT messages_recurring_post_id_fkey
        FOREIGN KEY (recurring_post_id) REFERENCES recurring_posts(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    ALTER TABLE messages ADD CONSTRAINT messages_trigger_rule_id_fkey
        FOREIGN KEY (trigger_rule_id) REFERENCES trigger_rules(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- 1件の発言はrecurring_posts由来かtrigger_rules由来かのどちらか一方（またはどちらでもないF-43等）
-- （05-1_詳細設計書_DB設計.html 3.5節）
DO $$ BEGIN
    ALTER TABLE messages ADD CONSTRAINT messages_recurring_or_trigger_check
        CHECK (recurring_post_id IS NULL OR trigger_rule_id IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- T-09 doc_folders / T-10 channel_doc_folders（参照ドキュメント範囲、F-22。
-- 05-1_詳細設計書_DB設計.html 3.9節）。管理者がGoogle Driveのフォルダを候補として登録し（T-09）、
-- チャンネルごとに使用する候補を選ぶ（T-10）。このスライスはフォルダの登録・チャンネルへの
-- 割当までを対象とし、実際のDrive同期・埋め込み索引・AI検索（基本設計書8.2節のsearch_documents）
-- は次スライスで実装する（CLAUDE.md実装状況節）。
CREATE TABLE IF NOT EXISTS doc_folders (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    drive_folder_id    TEXT NOT NULL UNIQUE,
    drive_folder_name  TEXT NOT NULL,
    added_by           BIGINT NOT NULL REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE doc_folders ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS channel_doc_folders (
    channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    folder_id   BIGINT NOT NULL REFERENCES doc_folders(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, folder_id)
);
ALTER TABLE channel_doc_folders ENABLE ROW LEVEL SECURITY;

-- doc_foldersにitem_type/parent_folder_idを追加（フォルダ内の特定ファイルだけを参照範囲に
-- 含められるようにする、F-22の拡張。ユーザーからの明示的な要望）。実際のDrive APIでフォルダの
-- 中身を自動列挙する方式は、Drive OAuthスコープの全社展開・GCP側のDrive API有効化のいずれも
-- 未解決のため今回は見送り、フォルダ登録（A-39）と同じ「URL/IDの手動貼り付け」方式のまま
-- 個別ファイルも登録できるようにした（着手前にユーザーへ確認し、この方式を選択）。folder/file
-- を同じテーブルで扱うのは、T-10 channel_doc_foldersが「idの集合を洗い替える」既存の仕組み
-- （A-27）をそのまま使い回すため（ファイルもフォルダも「参照範囲の1項目」という点では同じで、
-- 検索対象を区別する必要が生じるのは実際のAI検索実装時）。drive_folder_id/drive_folder_name列は
-- item_type='file'の行でもそのまま使う（bot_display_name等、既存列を種別問わず使い回す
-- このコードベースの既存パターンを踏襲し、新規に列を増やさない）。
ALTER TABLE doc_folders ADD COLUMN IF NOT EXISTS item_type TEXT NOT NULL DEFAULT 'folder';
ALTER TABLE doc_folders ADD COLUMN IF NOT EXISTS parent_folder_id BIGINT REFERENCES doc_folders(id) ON DELETE CASCADE;
DO $$ BEGIN
    ALTER TABLE doc_folders ADD CONSTRAINT doc_folders_item_type_check
        CHECK (item_type IN ('folder', 'file'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    -- フォルダ（トップレベル候補）はparent_folder_id NULL、ファイルは必ずどのフォルダの子かを持つ
    ALTER TABLE doc_folders ADD CONSTRAINT doc_folders_parent_matches_type_check
        CHECK ((item_type = 'folder' AND parent_folder_id IS NULL) OR (item_type = 'file' AND parent_folder_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- T-16 audit_logs（監査ログ、S-08「監査ログ」タブ。05-1_詳細設計書_DB設計.html 3.12節）。
-- 「いつ・誰が・どの項目を」変更したかのみを記録し、変更内容そのもの（過去バージョン・差分）は
-- 保持しない（summaryは種類の説明のみで実際の入力値は含めない）。event_type='login'はA-02
-- コールバック・dev-loginの成功時、'channel_ai_setting_change'はA-24〜A-27・A-45の成功時に
-- backend/audit_log.pyのrecord()から書き込む。target_channel_idはON DELETE SET NULLとし、
-- チャンネル削除後も監査記録自体は残す（messages.recurring_post_id等と同じ「履歴は消さない」
-- 設計判断。ここだけCASCADEにすると監査ログの目的に反してしまう）。
CREATE TABLE IF NOT EXISTS audit_logs (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type          TEXT NOT NULL CHECK (event_type IN ('login', 'channel_ai_setting_change')),
    actor_user_id       BIGINT NOT NULL REFERENCES users(id),
    target_channel_id   BIGINT REFERENCES channels(id) ON DELETE SET NULL,
    target_field        TEXT,
    summary             TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at);
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- T-11 channel_skills（スキル、F-12。05-1_詳細設計書_DB設計.html 3.10節）。チャンネルAIに
-- 割り当てる「依頼を受けたらこう進める」手順（タイトル＋本文）。services/ai_agent.pyの
-- システムプロンプト「# あなたのスキル」節で列挙する（詳細設計書AIサポート10.2節）。
CREATE TABLE IF NOT EXISTS channel_skills (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id    BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    instructions  TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE channel_skills ENABLE ROW LEVEL SECURITY;

-- T-12 channel_auto_response_rules（自動対応範囲、F-16。05-1_詳細設計書_DB設計.html 3.10節）。
-- 依頼内容カテゴリ（request_category）ごとに対応区分（response_level: auto/confirm/human）を
-- チャンネルAIへ割り当てる。services/ai_agent.pyのシステムプロンプト「# あなたが対応してよい
-- 依頼の目安」節で列挙する（詳細設計書AIサポート10.2節）。request_categoryはチャンネル管理者が
-- 自由に追加・削除できる（REQ-F-15「担当部署が自ら決められる」を優先し、モックアップの6例は
-- 固定の候補ではなく単なる記入例として扱う）。
CREATE TABLE IF NOT EXISTS channel_auto_response_rules (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id        BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    request_category  TEXT NOT NULL,
    response_level    TEXT NOT NULL CHECK (response_level IN ('auto', 'confirm', 'human')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (channel_id, request_category)
);
ALTER TABLE channel_auto_response_rules ENABLE ROW LEVEL SECURITY;
"""


def _pool_kwargs() -> dict:
    """接続先に応じた asyncpg のオプションを組み立てる。

    Supabase の Transaction pooler（Supavisor / port 6543）は接続がトランザクション単位で
    使い回されるため、asyncpg のプリペアドステートメントのキャッシュが機能しない
    （`prepared statement "__asyncpg_stmt_x__" already exists` になる）。
    その場合は statement_cache_size=0 でキャッシュを無効化する。
    Session pooler（5432）と直接接続ではキャッシュを有効なままにしてよい。
    """
    kwargs: dict = {"min_size": 1, "max_size": int(os.environ.get("DB_POOL_MAX", "10"))}
    is_transaction_pooler = ":6543" in DATABASE_URL or "pgbouncer=true" in DATABASE_URL
    if os.environ.get("DB_DISABLE_STATEMENT_CACHE", "1" if is_transaction_pooler else "0") == "1":
        kwargs["statement_cache_size"] = 0
    return kwargs


async def init_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(DATABASE_URL, **_pool_kwargs())
        if AUTO_MIGRATE:
            async with _pool.acquire() as conn:
                await conn.execute(SCHEMA)
    return _pool


def get_pool() -> asyncpg.Pool:
    assert _pool is not None, "init_pool() が呼ばれていません"
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
