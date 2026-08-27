# 開発用の初期データ投入（start.bat から自動実行される）。
# DBが起動していない/未作成の場合は例外を投げて呼び出し元（start.bat）にリトライさせる。
# 各エンティティごとに「無ければ作る」形にしてあるので、画面単位スライスを追加するたびに
# この関数へ追記すればよい（全体を一度きりのブロックにすると、後から追加した分がユーザー
# 作成済みの既存DBでは投入されないまま気づかれない、という事故が起きるため）。
import asyncio
import sys

import asyncpg

import database

# Windowsのコンソールが既定のcp932だと日本語のprintでUnicodeEncodeErrorになるため、
# 標準出力をUTF-8に強制する（start.bat経由でも手動実行でも同じ挙動にする）
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")


async def main() -> None:
    pool = await asyncpg.create_pool(database.DATABASE_URL, min_size=1, max_size=2)
    try:
        async with pool.acquire() as conn:
            await conn.execute(database.SCHEMA)

            admin_id = await conn.fetchval("SELECT id FROM users WHERE email = $1", "admin@kogasoftware.com")
            if admin_id is None:
                admin_id = await conn.fetchval(
                    "INSERT INTO users (email, name, role) VALUES ($1, $2, 'admin') RETURNING id",
                    "admin@kogasoftware.com", "石井 直樹",
                )
                print("seed.py: 開発用ユーザー admin@kogasoftware.com を投入しました")

            member_id = await conn.fetchval("SELECT id FROM users WHERE email = $1", "yamada@kogasoftware.com")
            if member_id is None:
                member_id = await conn.fetchval(
                    "INSERT INTO users (email, name, role) VALUES ($1, $2, 'member') RETURNING id",
                    "yamada@kogasoftware.com", "山田 太郎",
                )
                print("seed.py: 開発用ユーザー yamada@kogasoftware.com を投入しました")

            sato_id = await conn.fetchval("SELECT id FROM users WHERE email = $1", "sato@kogasoftware.com")
            if sato_id is None:
                sato_id = await conn.fetchval(
                    "INSERT INTO users (email, name, role) VALUES ($1, $2, 'member') RETURNING id",
                    "sato@kogasoftware.com", "佐藤 花子",
                )
                print("seed.py: 開発用ユーザー sato@kogasoftware.com を投入しました")

            channel_id = await conn.fetchval("SELECT id FROM channels WHERE name = $1", "雑談")
            if channel_id is None:
                channel_id = await conn.fetchval(
                    """INSERT INTO channels (name, topic, is_public, created_by)
                       VALUES ('雑談', '気軽に話すチャンネル', true, $1) RETURNING id""",
                    admin_id,
                )
                await conn.execute(
                    """INSERT INTO channel_members (channel_id, user_id, is_channel_admin) VALUES
                        ($1, $2, true), ($1, $3, false)""",
                    channel_id, admin_id, member_id,
                )
                await conn.execute(
                    """INSERT INTO messages (channel_id, sender_type, sender_user_id, body) VALUES
                        ($1, 'human', $2, 'ようこそ「雑談」チャンネルへ！')""",
                    channel_id, admin_id,
                )
                print("seed.py: 開発用チャンネル「雑談」（発言1件・メンバー2名）を投入しました")

            dm_id = await conn.fetchval(
                """SELECT dm_id FROM direct_message_members
                   GROUP BY dm_id
                   HAVING array_agg(user_id ORDER BY user_id) = $1::bigint[]""",
                sorted([admin_id, member_id]),
            )
            if dm_id is None:
                dm_id = await conn.fetchval(
                    "INSERT INTO direct_messages (created_by) VALUES ($1) RETURNING id", admin_id,
                )
                await conn.execute(
                    """INSERT INTO direct_message_members (dm_id, user_id) VALUES
                        ($1, $2), ($1, $3)""",
                    dm_id, admin_id, member_id,
                )
                await conn.execute(
                    """INSERT INTO messages (dm_id, sender_type, sender_user_id, body) VALUES
                        ($1, 'human', $2, 'DM機能の動作確認です。よろしくお願いします。')""",
                    dm_id, admin_id,
                )
                print("seed.py: 開発用DM（admin⇔yamada、発言1件）を投入しました")
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
