# A-05〜A-08, A-10〜A-11, A-46〜A-49（詳細設計書 API設計4.3節・4.6節、総論5.1節・5.3節）
# このスライスではメンション（F-41）・添付ファイル・送信予約は未実装。
# S-06チャンネル設定は「チャンネル管理者」タブ（chadmin追加解除＋公開範囲切替）のみ実装し、
# 定期投稿・自動応答トリガー・AI設定7タブは対応する基盤（スケジューラ・AIエンジン）が
# 未実装のため対象外（CLAUDE.md 実装状況節）。
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_helpers import CurrentUser, require_auth, require_channel_admin, require_channel_member
from database import get_pool

router = APIRouter(prefix="/api/channels", tags=["channels"])


def _channel_out(row) -> dict:
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "topic": row["topic"],
        "is_public": row["is_public"],
        "created_by": str(row["created_by"]),
        "created_at": row["created_at"].isoformat(),
    }


@router.get("")
async def list_channels(user: CurrentUser = Depends(require_auth)):
    """A-05: 参加中チャンネル一覧＋参加可能な公開チャンネル一覧（総論5.3節）。
    joinedのunread_countはT-22 read_states（未読バッジ、基本設計書4.2節）を使って算出する。"""
    pool = get_pool()
    joined = await pool.fetch(
        """SELECT c.*,
               (SELECT count(*) FROM messages msg
                WHERE msg.channel_id = c.id AND msg.deleted_at IS NULL AND msg.thread_parent_id IS NULL
                  AND msg.sender_user_id IS DISTINCT FROM $1
                  AND msg.created_at > COALESCE(rs.last_read_at, cm.joined_at)
               ) AS unread_count
           FROM channels c
           JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $1
           LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = $1
           ORDER BY c.name""",
        user.id,
    )
    joinable = await pool.fetch(
        """SELECT c.* FROM channels c
           WHERE c.is_public = true
             AND c.id NOT IN (SELECT channel_id FROM channel_members WHERE user_id = $1)
           ORDER BY c.name""",
        user.id,
    )
    return {
        "joined": [{**_channel_out(r), "unread_count": r["unread_count"]} for r in joined],
        "joinable": [_channel_out(r) for r in joinable],
    }


class CreateChannelRequest(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    topic: str | None = None
    is_public: bool = True


@router.post("", status_code=201)
async def create_channel(body: CreateChannelRequest, user: CurrentUser = Depends(require_auth)):
    """A-07: チャンネル作成。作成者は自動的にchadminとして登録される（F-33）"""
    pool = get_pool()
    exists = await pool.fetchval("SELECT EXISTS(SELECT 1 FROM channels WHERE name = $1)", body.name)
    if exists:
        raise HTTPException(409, detail="既に使用されています")
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            """INSERT INTO channels (name, topic, is_public, created_by)
               VALUES ($1, $2, $3, $4) RETURNING *""",
            body.name, body.topic, body.is_public, user.id,
        )
        await conn.execute(
            """INSERT INTO channel_members (channel_id, user_id, is_channel_admin)
               VALUES ($1, $2, true)""",
            row["id"], user.id,
        )
    return _channel_out(row)


@router.get("/{channel_id}")
async def get_channel(channel_id: int, user: CurrentUser = Depends(require_channel_member)):
    """A-06: チャンネル詳細"""
    pool = get_pool()
    row = await pool.fetchrow("SELECT * FROM channels WHERE id = $1", channel_id)
    member_count = await pool.fetchval(
        "SELECT count(*) FROM channel_members WHERE channel_id = $1", channel_id
    )
    is_admin = await pool.fetchval(
        "SELECT is_channel_admin FROM channel_members WHERE channel_id = $1 AND user_id = $2",
        channel_id, user.id,
    )
    return {**_channel_out(row), "member_count": member_count, "is_channel_admin": bool(is_admin)}


@router.post("/{channel_id}/members", status_code=201)
async def join_channel(channel_id: int, user: CurrentUser = Depends(require_auth)):
    """A-08: 参加（このスライスは公開チャンネルへの自己参加のみ。非公開チャンネルへの招待は次スライス）"""
    pool = get_pool()
    channel = await pool.fetchrow("SELECT is_public FROM channels WHERE id = $1", channel_id)
    if channel is None:
        raise HTTPException(404, detail="見つかりません")
    if not channel["is_public"]:
        raise HTTPException(403, detail="非公開チャンネルへの参加には招待が必要です")
    already = await pool.fetchval(
        "SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)",
        channel_id, user.id,
    )
    if already:
        raise HTTPException(409, detail="既に参加しています")
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            """INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
               RETURNING channel_id, user_id, is_channel_admin, joined_at""",
            channel_id, user.id,
        )
        # F-43: 入室通知。F-36/F-38と同じsender_type='bot'を流用し、新規テーブル・列は追加しない
        # （基本設計書6.2節「設計判断」）。表示名は固定で「システム通知」
        await conn.execute(
            """INSERT INTO messages (channel_id, sender_type, bot_display_name, body)
               VALUES ($1, 'bot', 'システム通知', $2)""",
            channel_id, f"{user.name} さんが参加しました。",
        )
    return {
        "channel_id": str(row["channel_id"]), "user_id": str(row["user_id"]),
        "is_channel_admin": row["is_channel_admin"], "joined_at": row["joined_at"].isoformat(),
    }


@router.get("/{channel_id}/members")
async def list_channel_members(channel_id: int, user: CurrentUser = Depends(require_channel_member)):
    """A-46: 参加者一覧（chadminバッジ表示・S-06チャンネル管理者タブでの追加候補選定に使用）"""
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT u.id, u.name, u.email, u.picture_url, cm.is_channel_admin, cm.joined_at
           FROM channel_members cm JOIN users u ON u.id = cm.user_id
           WHERE cm.channel_id = $1 ORDER BY u.name""",
        channel_id,
    )
    return {
        "items": [
            {
                "id": str(r["id"]), "name": r["name"], "email": r["email"], "picture_url": r["picture_url"],
                "is_channel_admin": r["is_channel_admin"], "joined_at": r["joined_at"].isoformat(),
            }
            for r in rows
        ]
    }


class AddAdminRequest(BaseModel):
    user_id: str


@router.post("/{channel_id}/admins", status_code=201)
async def add_channel_admin(
    channel_id: int, body: AddAdminRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-47: chadmin追加。対象はこのチャンネルの参加者に限る（基本設計書4.8節）"""
    pool = get_pool()
    try:
        target_id = int(body.user_id)
    except ValueError:
        raise HTTPException(422, detail="不正なuser_idです")
    row = await pool.fetchrow(
        """UPDATE channel_members SET is_channel_admin = true
           WHERE channel_id = $1 AND user_id = $2 RETURNING user_id""",
        channel_id, target_id,
    )
    if row is None:
        raise HTTPException(404, detail="このチャンネルの参加者ではありません")
    return {"channel_id": str(channel_id), "user_id": str(target_id), "is_channel_admin": True}


@router.delete("/{channel_id}/admins/{target_user_id}")
async def remove_channel_admin(
    channel_id: int, target_user_id: int, user: CurrentUser = Depends(require_channel_admin),
):
    """A-48: chadmin解除。管理者不在を防ぐため最後の1人は拒否する（F-33）"""
    pool = get_pool()
    is_target_admin = await pool.fetchval(
        "SELECT is_channel_admin FROM channel_members WHERE channel_id = $1 AND user_id = $2",
        channel_id, target_user_id,
    )
    if is_target_admin is None:
        raise HTTPException(404, detail="このチャンネルの参加者ではありません")
    if is_target_admin:
        admin_count = await pool.fetchval(
            "SELECT count(*) FROM channel_members WHERE channel_id = $1 AND is_channel_admin", channel_id
        )
        if admin_count <= 1:
            raise HTTPException(400, detail="最後の管理者は解除できません")
    await pool.execute(
        "UPDATE channel_members SET is_channel_admin = false WHERE channel_id = $1 AND user_id = $2",
        channel_id, target_user_id,
    )
    return {"channel_id": str(channel_id), "user_id": str(target_user_id), "is_channel_admin": False}


class VisibilityRequest(BaseModel):
    is_public: bool


@router.put("/{channel_id}/visibility")
async def update_visibility(
    channel_id: int, body: VisibilityRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-49: 公開/非公開切替（F-34）"""
    pool = get_pool()
    row = await pool.fetchrow(
        "UPDATE channels SET is_public = $2, updated_at = now() WHERE id = $1 RETURNING id, is_public",
        channel_id, body.is_public,
    )
    if row is None:
        raise HTTPException(404, detail="見つかりません")
    return {"id": str(row["id"]), "is_public": row["is_public"]}


@router.post("/{channel_id}/read")
async def mark_channel_read(channel_id: int, user: CurrentUser = Depends(require_channel_member)):
    """A-69: このチャンネルを既読にする（未読バッジ用。基本設計書4.2節「設計判断」）。
    最終既読時刻を現在時刻に更新するだけで、個々のメッセージ単位では管理しない。"""
    pool = get_pool()
    await pool.execute(
        """INSERT INTO read_states (user_id, channel_id, last_read_at) VALUES ($1, $2, now())
           ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL
           DO UPDATE SET last_read_at = now()""",
        user.id, channel_id,
    )
    return {"channel_id": str(channel_id), "read": True}


def _message_out(row) -> dict:
    return {
        "id": str(row["id"]),
        "channel_id": str(row["channel_id"]),
        "sender_type": row["sender_type"],
        "sender_user_id": str(row["sender_user_id"]) if row["sender_user_id"] is not None else None,
        # BOT発言（sender_user_id無し）はbot_display_nameを表示名として使う（F-36/F-38/F-43）
        "sender_name": row["bot_display_name"] if row["sender_type"] == "bot" else row["sender_name"],
        "body": row["body"],
        "generation_status": row["generation_status"],
        "thread_reply_count": row["thread_reply_count"],
        "created_at": row["created_at"].isoformat(),
    }


_MESSAGES_SELECT = """SELECT m.*, u.name AS sender_name,
       (SELECT count(*) FROM messages r WHERE r.thread_parent_id = m.id AND r.deleted_at IS NULL)
           AS thread_reply_count
   FROM messages m
   LEFT JOIN users u ON u.id = m.sender_user_id"""


@router.get("/{channel_id}/messages")
async def list_messages(
    channel_id: int, since: str | None = None, limit: int = 50,
    user: CurrentUser = Depends(require_channel_member),
):
    """A-10: 履歴取得。sinceは3秒間隔ポーリングの差分取得に使う（基本設計書9.1節）。
    thread_reply_countはS-04スレッド表示への導線（「N件の返信」）に使う（詳細設計書 API設計4.3節）"""
    pool = get_pool()
    if since:
        since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        rows = await pool.fetch(
            f"""{_MESSAGES_SELECT}
               WHERE m.channel_id = $1 AND m.deleted_at IS NULL AND m.thread_parent_id IS NULL
                 AND m.created_at > $2
               ORDER BY m.created_at ASC""",
            channel_id, since_dt,
        )
        return {"items": [_message_out(r) for r in rows], "has_more": False}
    rows = await pool.fetch(
        f"""{_MESSAGES_SELECT}
           WHERE m.channel_id = $1 AND m.deleted_at IS NULL AND m.thread_parent_id IS NULL
           ORDER BY m.created_at DESC LIMIT $2""",
        channel_id, limit,
    )
    return {"items": [_message_out(r) for r in reversed(rows)], "has_more": len(rows) == limit}


class PostMessageRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


@router.post("/{channel_id}/messages", status_code=201)
async def post_message(
    channel_id: int, body: PostMessageRequest, user: CurrentUser = Depends(require_channel_member),
):
    """A-11: メッセージ投稿。このスライスは人間の発言保存のみ（AI応答・トリガー判定は次スライス）"""
    pool = get_pool()
    row = await pool.fetchrow(
        """INSERT INTO messages (channel_id, sender_type, sender_user_id, body)
           VALUES ($1, 'human', $2, $3) RETURNING *""",
        channel_id, user.id, body.body,
    )
    return _message_out({**dict(row), "sender_name": user.name, "thread_reply_count": 0})
