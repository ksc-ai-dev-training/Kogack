# A-16〜A-19（詳細設計書 API設計4.4節、総論5.1節）
# グループDM対応。参加者は開始時に固定（開始後の追加・削除は対象外、05-1_詳細設計書_DB設計.html 3.17節）
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_helpers import CurrentUser, require_auth, require_dm_member
from database import get_pool

router = APIRouter(prefix="/api/dms", tags=["dms"])


async def _dm_out(pool, dm_id: int, created_at, self_user_id: int, unread_count: int = 0) -> dict:
    members = await pool.fetch(
        """SELECT u.id, u.name, u.picture_url FROM direct_message_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.dm_id = $1 AND u.id <> $2 ORDER BY u.name""",
        dm_id, self_user_id,
    )
    return {
        "id": str(dm_id),
        "members": [
            {"id": str(r["id"]), "name": r["name"], "picture_url": r["picture_url"]} for r in members
        ],
        "created_at": created_at.isoformat(),
        "unread_count": unread_count,
    }


@router.get("")
async def list_dms(user: CurrentUser = Depends(require_auth)):
    """A-16: 参加中DM一覧。サイドバー表示用に相手（自分以外）の氏名・アイコンを解決済みで返す。
    unread_countはT-22 read_states（未読バッジ、基本設計書4.2節）を使って算出する。"""
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT d.id, d.created_at,
               (SELECT count(*) FROM messages msg
                WHERE msg.dm_id = d.id AND msg.deleted_at IS NULL AND msg.thread_parent_id IS NULL
                  AND msg.sender_user_id IS DISTINCT FROM $1
                  AND msg.created_at > COALESCE(rs.last_read_at, dmm.joined_at)
               ) AS unread_count
           FROM direct_messages d
           JOIN direct_message_members dmm ON dmm.dm_id = d.id AND dmm.user_id = $1
           LEFT JOIN read_states rs ON rs.dm_id = d.id AND rs.user_id = $1
           ORDER BY d.created_at DESC""",
        user.id,
    )
    return {
        "items": [
            await _dm_out(pool, r["id"], r["created_at"], user.id, r["unread_count"]) for r in rows
        ]
    }


class CreateDmRequest(BaseModel):
    member_user_ids: list[str] = Field(min_length=1)


@router.post("", status_code=201)
async def create_dm(body: CreateDmRequest, user: CurrentUser = Depends(require_auth)):
    """A-17: DM開始。呼び出し元を加えた参加者集合が既存DMと完全一致すればそれを返す（200相当だがcreatedで判別）"""
    pool = get_pool()
    try:
        other_ids = {int(v) for v in body.member_user_ids}
    except ValueError:
        raise HTTPException(422, detail="不正なuser_idです")
    other_ids.discard(user.id)
    if not other_ids:
        raise HTTPException(422, detail="相手を1名以上指定してください")

    valid_count = await pool.fetchval(
        "SELECT count(*) FROM users WHERE id = ANY($1::bigint[]) AND is_active", list(other_ids)
    )
    if valid_count != len(other_ids):
        raise HTTPException(404, detail="見つかりません")

    full_set = sorted(other_ids | {user.id})
    existing_dm_id = await pool.fetchval(
        """SELECT dm_id FROM direct_message_members
           GROUP BY dm_id
           HAVING array_agg(user_id ORDER BY user_id) = $1::bigint[]""",
        full_set,
    )
    if existing_dm_id is not None:
        row = await pool.fetchrow("SELECT created_at FROM direct_messages WHERE id = $1", existing_dm_id)
        return {**await _dm_out(pool, existing_dm_id, row["created_at"], user.id), "created": False}

    async with pool.acquire() as conn, conn.transaction():
        dm_row = await conn.fetchrow(
            "INSERT INTO direct_messages (created_by) VALUES ($1) RETURNING id, created_at", user.id
        )
        await conn.executemany(
            "INSERT INTO direct_message_members (dm_id, user_id) VALUES ($1, $2)",
            [(dm_row["id"], uid) for uid in full_set],
        )
    return {**await _dm_out(pool, dm_row["id"], dm_row["created_at"], user.id), "created": True}


@router.post("/{dm_id}/read")
async def mark_dm_read(dm_id: int, user: CurrentUser = Depends(require_dm_member)):
    """A-70: このDMを既読にする（未読バッジ用。channels.mark_channel_readと同じ考え方）"""
    pool = get_pool()
    await pool.execute(
        """INSERT INTO read_states (user_id, dm_id, last_read_at) VALUES ($1, $2, now())
           ON CONFLICT (user_id, dm_id) WHERE dm_id IS NOT NULL
           DO UPDATE SET last_read_at = now()""",
        user.id, dm_id,
    )
    return {"dm_id": str(dm_id), "read": True}


def _message_out(row) -> dict:
    return {
        "id": str(row["id"]),
        "dm_id": str(row["dm_id"]),
        "sender_type": row["sender_type"],
        "sender_user_id": str(row["sender_user_id"]) if row["sender_user_id"] is not None else None,
        # BOT発言（sender_user_id無し）はbot_display_nameを表示名として使う（F-36/F-38/F-43）
        "sender_name": row["bot_display_name"] if row["sender_type"] == "bot" else row["sender_name"],
        # AI発言はbot_icon_urlにペルソナアイコンのスナップショットを持つ（services/ai_agent.py。
        # ただしAI応答はチャンネルのみ対応のためDMでは実際には発生しない）。BOT発言は
        # sender_user_idが無いためJOIN結果が自然にNULLになる（アイコン未実装、F-36/F-38）
        "sender_picture_url": row["bot_icon_url"] if row["sender_type"] == "ai" else row["sender_picture_url"],
        "body": row["body"],
        "generation_status": row["generation_status"],
        "thread_reply_count": row["thread_reply_count"],
        # F-41 @メンションはチャンネルのみ対応（候補元のA-46がチャンネル参加者一覧のため）。
        # DM発言は常に空配列とし、フロント側でMessage型の形を揃える。
        "blocks": [],
        "created_at": row["created_at"].isoformat(),
    }


_MESSAGES_SELECT = """SELECT m.*, u.name AS sender_name, u.picture_url AS sender_picture_url,
       (SELECT count(*) FROM messages r WHERE r.thread_parent_id = m.id AND r.deleted_at IS NULL)
           AS thread_reply_count
   FROM messages m
   LEFT JOIN users u ON u.id = m.sender_user_id"""


@router.get("/{dm_id}/messages")
async def list_messages(
    dm_id: int, since: str | None = None, limit: int = 50,
    user: CurrentUser = Depends(require_dm_member),
):
    """A-18: 履歴取得。channels.list_messagesと同じsince差分ポーリング方式（基本設計書9.1節）"""
    pool = get_pool()
    if since:
        since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        rows = await pool.fetch(
            f"""{_MESSAGES_SELECT}
               WHERE m.dm_id = $1 AND m.deleted_at IS NULL AND m.thread_parent_id IS NULL
                 AND m.created_at > $2
               ORDER BY m.created_at ASC""",
            dm_id, since_dt,
        )
        return {"items": [_message_out(r) for r in rows], "has_more": False}
    rows = await pool.fetch(
        f"""{_MESSAGES_SELECT}
           WHERE m.dm_id = $1 AND m.deleted_at IS NULL AND m.thread_parent_id IS NULL
           ORDER BY m.created_at DESC LIMIT $2""",
        dm_id, limit,
    )
    return {"items": [_message_out(r) for r in reversed(rows)], "has_more": len(rows) == limit}


class PostMessageRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


@router.post("/{dm_id}/messages", status_code=201)
async def post_message(dm_id: int, body: PostMessageRequest, user: CurrentUser = Depends(require_dm_member)):
    """A-19: メッセージ投稿"""
    pool = get_pool()
    row = await pool.fetchrow(
        """INSERT INTO messages (dm_id, sender_type, sender_user_id, body)
           VALUES ($1, 'human', $2, $3) RETURNING *""",
        dm_id, user.id, body.body,
    )
    return _message_out(
        {**dict(row), "sender_name": user.name, "sender_picture_url": user.picture_url, "thread_reply_count": 0}
    )
