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

# 本番（Supabase）は自動マイグレーションを行わず、SCHEMA は手動適用する。
# 起動のたびに CREATE TABLE を流さないよう APP_ENV=production では抑止する
APP_ENV = os.environ.get("APP_ENV") or ROOT_ENV.get("APP_ENV", "development")
AUTO_MIGRATE = (
    os.environ.get("AUTO_MIGRATE") or ROOT_ENV.get("AUTO_MIGRATE") or ("0" if APP_ENV == "production" else "1")
) == "1"

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
