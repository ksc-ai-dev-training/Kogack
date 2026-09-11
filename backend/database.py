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
-- F-41 @here（2026-09-11、ユーザーからの明示的な要望）用の在席判定。A-04（/api/auth/me）が
-- ポーリングのたびに更新する（タブが非表示だとポーリング自体が止まるため、更新が続いている＝
-- 実際にタブを開いて見ていることの目印になる。mentions.pyのHERE_ACTIVE_WINDOW_SECONDS参照）
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

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
-- フォルダ（トップレベル候補）はparent_folder_id NULL、ファイルは必ずどのフォルダの子かを持つ、
-- という制約は元々ここでdoc_folders_parent_matches_type_checkとして追加していたが、
-- source='upload'（実ファイルアップロード、2026-09-09）の追加に伴いsource別の条件へ差し替える
-- 必要が生じたため、この場所でのADD自体は行わず、後方のsource追加ブロックでDROP→
-- doc_folders_parent_matches_type_check_v2として再作成する（SCHEMAは起動のたびに全文を
-- 実行する設計のため、ここに`ADD CONSTRAINT doc_folders_parent_matches_type_check`を
-- 残したままだと、既にv2へ差し替わった後の起動のたびに、v2制約下では許容されている
-- upload行[item_type='file' AND parent_folder_id IS NULL]に対して旧制約が違反判定され
-- CheckViolationErrorで起動そのものが失敗する。ローカルでの2回連続起動テストで実際に
-- この失敗を確認した上でこの形にした）。

-- doc_foldersに実ファイルアップロード（source='upload'）を追加し、URL貼り付け専用だった
-- doc_foldersをDrive参照とアップロードの両対応にする（層2参照ドキュメント、2026-09-09。
-- CLAUDE.md実装状況節を参照）。Google Workspace管理コンソールの制限でDrive API自体が
-- 呼び出せない状態が続いているため、実ファイルを直接アップロードする経路を追加した。
-- drive_folder_id/drive_folder_nameは既存パターン（種別問わず既存列を使い回す）を踏襲し、
-- source='upload'ではdrive_folder_nameにアップロード時の元ファイル名を格納する。
-- 保存先はFly Volume（/data、fly.tomlの[[mounts]]参照）で、storage_pathにそのマウント配下の
-- 相対パスを持つ。drive_folder_idは元々NOT NULL UNIQUEだったが、source='upload'の行では
-- 使わないためNOT NULLを外した（UNIQUE制約はNULL同士を区別しないPostgresの挙動により、
-- 複数のupload行が共存しても違反にならない）。item_typeは'upload'では常に'file'固定とし
-- （フォルダ単位の一括アップロードは今回のスライス対象外）、フォルダでの整理が必要になれば
-- 次のスライスで検討する。
ALTER TABLE doc_folders ALTER COLUMN drive_folder_id DROP NOT NULL;
ALTER TABLE doc_folders ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'drive';
ALTER TABLE doc_folders ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE doc_folders ADD COLUMN IF NOT EXISTS byte_size BIGINT;
ALTER TABLE doc_folders ADD COLUMN IF NOT EXISTS mime_type TEXT;
DO $$ BEGIN
    ALTER TABLE doc_folders ADD CONSTRAINT doc_folders_source_check CHECK (source IN ('drive', 'upload'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- 旧doc_folders_parent_matches_type_checkは「item_type='file'なら必ずparent_folder_idを持つ」
-- という、Drive候補（フォルダ内の特定ファイルとして登録する方式）だけを前提にした制約だった。
-- source='upload'の実ファイルはフォルダに紐づかないトップレベル項目のため、この制約を
-- source別に緩めた形へ差し替える（DROP→再CREATEでのみ変更可能なため一旦削除する）。
ALTER TABLE doc_folders DROP CONSTRAINT IF EXISTS doc_folders_parent_matches_type_check;
-- アップロードのフォルダ単位グループ化（2026-09-09、ユーザーからの報告「フォルダごとD&Dしても
-- ファイルがバラのまま管理される」への対応）にともない、_v2をさらに緩めて_v3へ差し替える。
-- 従来はsource='upload'のfileが常にparent_folder_id IS NULL（フォルダに属せない）だったが、
-- 「アップロードで作った仮想フォルダ（source='upload' AND item_type='folder'、ファイル実体を
-- 持たない）の子」というケースを新たに許可する必要があるため、source='upload'のfileは
-- parent_folder_idのNULL/NOT NULLどちらも許容する形に緩めた（親が実在しfolder種別であることは
-- アプリ層でチェックする、create_doc_folderの既存パターンを踏襲）。
-- _v2自体もDROPしてから作り直す（前回と同じ「旧ADD文を残すと次回起動でCheckViolationErrorになる」
-- 教訓どおり、旧バージョンのADD文はここでは一切残さない）。
ALTER TABLE doc_folders DROP CONSTRAINT IF EXISTS doc_folders_parent_matches_type_check_v2;
DO $$ BEGIN
    ALTER TABLE doc_folders ADD CONSTRAINT doc_folders_parent_matches_type_check_v3
        CHECK (
            (item_type = 'folder' AND parent_folder_id IS NULL)
            OR (item_type = 'file' AND source = 'drive' AND parent_folder_id IS NOT NULL)
            OR (item_type = 'file' AND source = 'upload')
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- 同じくアップロードのフォルダ単位グループ化にともない、doc_folders_source_matches_columns_checkも
-- 「source='upload' AND item_type='folder'」（ファイル実体を持たない仮想フォルダ、drive_folder_id・
-- storage_pathともNULL）を許容する形へ差し替える。旧バージョンのADD文はここでは残さない
-- （同上の教訓）。
ALTER TABLE doc_folders DROP CONSTRAINT IF EXISTS doc_folders_source_matches_columns_check;
DO $$ BEGIN
    ALTER TABLE doc_folders ADD CONSTRAINT doc_folders_source_matches_columns_check_v2
        CHECK (
            (source = 'drive' AND drive_folder_id IS NOT NULL AND storage_path IS NULL)
            OR
            (source = 'upload' AND drive_folder_id IS NULL AND item_type = 'folder' AND storage_path IS NULL)
            OR
            (source = 'upload' AND drive_folder_id IS NULL AND item_type = 'file' AND storage_path IS NOT NULL)
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 層2参照ドキュメントの閲覧権限モデル（Slice 2b、2026-09-09。ユーザーと合意した設計。
-- CLAUDE.md実装状況節を参照）。doc_folders（フォルダ・ファイルどちらの行も）に
-- is_restricted（限定公開かどうか）を追加し、限定公開の場合のみ新規T-24 doc_folder_viewersで
-- 閲覧可能な利用者を管理する（全社公開のフォルダ・ファイルは従来どおり誰でも参照範囲に含められる）。
-- 「フォルダ単位・ファイル単位のどちらでも制御できる」という要望は、doc_foldersが元々
-- folder/file行を同じテーブルで扱う設計のため、行ごとにこの2列を持たせるだけで自然に満たせる
-- （新しい別テーブルを分ける必要はない）。
ALTER TABLE doc_folders ADD COLUMN IF NOT EXISTS is_restricted BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS doc_folder_viewers (
    folder_id   BIGINT NOT NULL REFERENCES doc_folders(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (folder_id, user_id)
);
ALTER TABLE doc_folder_viewers ENABLE ROW LEVEL SECURITY;

-- 層2参照ドキュメントの索引化・AI検索（Slice 3、2026-09-09。CLAUDE.md実装状況節を参照）。
-- Drive連携はdomainPolicyのブロックが続いており実ファイルを取得できないため、このスライスで
-- 実際に索引化できるのはsource='upload'の行のみ（source='drive'はindex_status='not_applicable'
-- のまま据え置く）。pgvector（Supabaseで利用可能、事前にCREATE EXTENSIONで有効化済み）で
-- 埋め込みベクトルを保持する。
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE doc_folders ADD COLUMN IF NOT EXISTS index_status TEXT NOT NULL DEFAULT 'not_applicable';
ALTER TABLE doc_folders ADD COLUMN IF NOT EXISTS index_error TEXT;
DO $$ BEGIN
    ALTER TABLE doc_folders ADD CONSTRAINT doc_folders_index_status_check
        CHECK (index_status IN ('not_applicable', 'pending', 'indexing', 'ready', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- T-25 doc_chunks: 1ファイルを複数のチャンク（断片）に分割し、それぞれの埋め込みベクトルを
-- 保持する。text-embedding-3-small（1536次元）を使う前提で固定次元にしている（モデルを
-- 変える場合はこの次元数も合わせて変更が必要）。folder_id削除時にON DELETE CASCADEで
-- 連動削除される。
CREATE TABLE IF NOT EXISTS doc_chunks (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    folder_id   BIGINT NOT NULL REFERENCES doc_folders(id) ON DELETE CASCADE,
    chunk_index INT NOT NULL,
    content     TEXT NOT NULL,
    embedding   vector(1536) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (folder_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_folder_id ON doc_chunks (folder_id);
ALTER TABLE doc_chunks ENABLE ROW LEVEL SECURITY;

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

-- T-23 google_drive_tokens: 層2ドキュメントQ&A（F-19〜F-22）向け、利用者ごとのGoogle Drive
-- アクセストークン保存先（05-1_詳細設計書_DB設計.html 3.23節）。access_tokenは短命（通常1時間）
-- なため、refresh_tokenを使って必要な時にサーバー側で更新する（google_auth.pyのrefresh_access_token
-- 参照）。user_idを主キーにし、1利用者につき最新の1組のみ保持する（履歴は持たない。再ログイン・
-- 再同意のたびに洗い替える）。refresh_tokenはGoogleがaccess_type=offline+prompt=consentの初回
-- 同意時のみ返す値のため、理論上は常に取得できるはずだがNULL許容にして防御的に扱う
-- （無い場合はaccess_token期限切れ時に再ログインが必要になるだけで、既存機能への影響は無い）
CREATE TABLE IF NOT EXISTS google_drive_tokens (
    user_id        BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token   TEXT NOT NULL,
    refresh_token  TEXT,
    expires_at     TIMESTAMPTZ NOT NULL,
    scope          TEXT NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE google_drive_tokens ENABLE ROW LEVEL SECURITY;

-- T-26 message_reactions: 発言への絵文字リアクション（ユーザーからの明示的な要望「Slackのように
-- 発言一つ一つに対して絵文字でリアクションできるようにしたい」）。1人が同じ発言に同じ絵文字を
-- 複数回付けられないようUNIQUE制約で防ぎ、backend/routers/messages.pyのA-75がトグル
-- （既に付けていれば削除、無ければ追加）として扱う。emojiはUnicodeの絵文字そのもの（結合絵文字・
-- 異体字セレクタを含む場合もある短い文字列）をそのままTEXTで保持し、種類を固定のCHECK制約等で
-- 縛らない（フロントの投稿欄と同じ絵文字ピッカーの選択肢に依存させず、将来ピッカー側の選択肢を
-- 増やしてもスキーマ変更が要らないようにするため）。message_id削除時はON DELETE CASCADEで
-- 連動削除する。
CREATE TABLE IF NOT EXISTS message_reactions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_message_id ON message_reactions (message_id);
ALTER TABLE message_reactions ENABLE ROW LEVEL SECURITY;

-- デスクトップ通知②（Web Push、2026-09-11、ユーザーからの明示的な要望「アプリを閉じていても
-- 通知が来るようにしたい」）。①（Web Notifications API、タブが開いている間のみ）に続く追加。
-- notif_modeは従来localStorageのみで管理していた「すべての新着」/「メンション・DMのみ」を
-- サーバー側にも持たせたもの（②はサーバー自身が誰に送るか判定する必要があるため）。
-- ①（hooks/useDesktopNotifications.ts）・②（services/push_sender.py）の両方がこの値を参照する。
ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_mode TEXT NOT NULL DEFAULT 'all'
    CHECK (notif_mode IN ('all', 'mentions'));
-- 'off'（通知をすべてオフにする、2026-09-11）を追加するため制約を広げる。既存値はall/mentionsの
-- ままなので広げても既存データに違反は起きない。2026-09-09に確立したパターンどおり、旧制約名を
-- 明示的にDROPしてから同名でADDし直す（旧ADD文自体は残さない。旧ADD文を残したまま次回起動すると、
-- 既にoff値を持つ行に対して旧い狭い制約が再実行されCheckViolationErrorで起動が失敗する事故が
-- 過去にdoc_foldersで発生したため）。既定値は'all'のまま変更しない（通知を許可するまでは
-- どのnotif_modeでも通知が一切飛ばないという既存の前提は変わらないため、既定を'off'にする必要はない）。
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_notif_mode_check;
ALTER TABLE users ADD CONSTRAINT users_notif_mode_check CHECK (notif_mode IN ('all', 'mentions', 'off'));

-- T-27 push_subscriptions: Web Push購読情報。1利用者が複数端末（会社PC・自宅PC等）で購読できるよう
-- endpoint単位で複数行持てる（UNIQUE(user_id, endpoint)で同じ端末の重複購読のみ防ぐ）。
-- p256dh/authはブラウザが発行する暗号化用の公開鍵・認証シークレット（暗号化はブラウザ側の
-- 秘密鍵で復号されるため、サーバー・プッシュ配送業者とも本文を読めない）。
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint    TEXT NOT NULL,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, endpoint)
);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- 文字数制限の見直し（2026-09-09、ユーザーからの明示的な要望）にともなう既存データの一括整形。
-- ユーザー名（21字）・チャンネル名（80字）・チャンネル説明文（500字）の新しい上限を超えている
-- 既存の行を先頭から切り詰める（LEFTは文字数ベースでマルチバイト文字も正しく扱う）。
-- WHERE char_length(...) > N の行が無くなれば以後は何もしなくなるため、AUTO_MIGRATE=1
-- （常時有効）で毎起動実行しても安全・冪等。本番DBへの直接UPDATE操作は権限の自動判定で
-- ブロックされたため、このSCHEMA経由の適用に切り替えた（2026-09-04の教訓と同じ対応方針）。
UPDATE users SET name = LEFT(name, 21), updated_at = now() WHERE char_length(name) > 21;
UPDATE channels SET name = LEFT(name, 80), updated_at = now() WHERE char_length(name) > 80;
UPDATE channels SET topic = LEFT(topic, 500), updated_at = now()
    WHERE topic IS NOT NULL AND char_length(topic) > 500;
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
