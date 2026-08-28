# A-12〜A-14（詳細設計書 API設計4.3節、基本設計書8.2節 S-04スレッド表示）
# スレッドはチャンネル・DMどちらの発言にもぶら下がれる（T-05.thread_parent_idは自己参照FKで
# channel_id/dm_idを問わない）ため、権限判定は元発言のchannel_id/dm_idに応じて分岐する
# （require_thread_access）。返信自体はネストしない（返信への返信は対象外）。
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_helpers import CurrentUser, require_auth, require_thread_access
from database import get_pool
from mentions import MentionInput, fetch_blocks_grouped, insert_mention_blocks

router = APIRouter(prefix="/api/messages", tags=["messages"])


def _message_out(row, blocks: list[dict] | None = None) -> dict:
    return {
        "id": str(row["id"]),
        "channel_id": str(row["channel_id"]) if row["channel_id"] is not None else None,
        "dm_id": str(row["dm_id"]) if row["dm_id"] is not None else None,
        "thread_parent_id": str(row["thread_parent_id"]) if row["thread_parent_id"] is not None else None,
        "sender_type": row["sender_type"],
        "sender_user_id": str(row["sender_user_id"]) if row["sender_user_id"] is not None else None,
        # BOT発言（sender_user_id無し）はbot_display_nameを表示名として使う（F-36/F-38/F-43）
        "sender_name": row["bot_display_name"] if row["sender_type"] == "bot" else row["sender_name"],
        # AI発言・BOT発言はいずれもbot_icon_urlにアイコンのスナップショットを持つ（services/ai_agent.py、
        # F-36/F-38の送り主アイコン）。BOT発言はsender_user_idが無いためJOIN結果が自然にNULLになる
        "sender_picture_url": row["bot_icon_url"] if row["sender_type"] in ("ai", "bot") else row["sender_picture_url"],
        # F-36/F-38の絵文字アイコン（画像未設定時のフォールバック。F-43システム通知は常にNULLなので
        # フロント側の既定🔔表示のまま）。AI・人間の発言では使わない
        "bot_icon": row["bot_icon"] if row["sender_type"] == "bot" else None,
        "body": row["body"],
        "generation_status": row["generation_status"],
        "blocks": blocks or [],
        "created_at": row["created_at"].isoformat(),
    }


@router.delete("/{message_id}")
async def delete_message(message_id: int, user: CurrentUser = Depends(require_auth)):
    """A-12: メッセージ削除（論理削除）。投稿者本人またはadminのみ実行できる（基本設計書8章）。
    チャンネル・DMどちらの発言、スレッド返信・元発言のいずれも同じ経路で扱う。"""
    pool = get_pool()
    row = await pool.fetchrow(
        """SELECT channel_id, dm_id, sender_user_id, sender_type, bot_display_name
           FROM messages WHERE id = $1 AND deleted_at IS NULL""",
        message_id,
    )
    if row is None:
        raise HTTPException(404, detail="見つかりません")
    if row["sender_type"] == "bot" and row["bot_display_name"] == "システム通知":
        # F-43のシステム通知（参加・退出の記録）は削除対象外とする（基本設計書6.2節「設計判断」）
        raise HTTPException(400, detail="システム通知は削除できません")

    if user.role != "admin":
        if row["channel_id"] is not None:
            is_member = await pool.fetchval(
                "SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)",
                row["channel_id"], user.id,
            )
        else:
            is_member = await pool.fetchval(
                "SELECT EXISTS(SELECT 1 FROM direct_message_members WHERE dm_id = $1 AND user_id = $2)",
                row["dm_id"], user.id,
            )
        if not is_member:
            # 参加していない会話の発言は存在自体を伏せる（総論5.3節と同じ考え方）
            raise HTTPException(404, detail="見つかりません")
        if row["sender_user_id"] != user.id:
            raise HTTPException(403, detail="権限がありません")

    await pool.execute(
        "UPDATE messages SET deleted_at = now(), deleted_by = $2 WHERE id = $1", message_id, user.id
    )
    return {"id": str(message_id), "deleted": True}


@router.get("/{message_id}/thread")
async def list_thread(message_id: int, user: CurrentUser = Depends(require_thread_access)):
    """A-13: スレッド内の返信一覧（古い順）"""
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT m.*, u.name AS sender_name, u.picture_url AS sender_picture_url FROM messages m
           LEFT JOIN users u ON u.id = m.sender_user_id
           WHERE m.thread_parent_id = $1 AND m.deleted_at IS NULL
           ORDER BY m.created_at ASC""",
        message_id,
    )
    blocks_by_message = await fetch_blocks_grouped(pool, [r["id"] for r in rows])
    return {"items": [_message_out(r, blocks_by_message.get(r["id"])) for r in rows]}


class PostReplyRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    mentions: list[MentionInput] = []


@router.post("/{message_id}/thread", status_code=201)
async def post_reply(
    message_id: int, body: PostReplyRequest, user: CurrentUser = Depends(require_thread_access),
):
    """A-14: スレッドへの返信投稿。channel_id/dm_idは元発言から引き継ぐ。@メンション（F-41）は
    元発言がチャンネルの場合のみT-07へ保存する（DMは候補元のA-46が無いため対象外）"""
    pool = get_pool()
    parent = await pool.fetchrow(
        "SELECT channel_id, dm_id, sender_type, bot_display_name FROM messages WHERE id = $1", message_id
    )
    if parent is None:
        raise HTTPException(404, detail="見つかりません")
    if parent["sender_type"] == "bot" and parent["bot_display_name"] == "システム通知":
        # F-43のシステム通知は返信対象外とする（基本設計書6.2節「設計判断」）
        raise HTTPException(400, detail="システム通知には返信できません")
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            """INSERT INTO messages (channel_id, dm_id, thread_parent_id, sender_type, sender_user_id, body)
               VALUES ($1, $2, $3, 'human', $4, $5) RETURNING *""",
            parent["channel_id"], parent["dm_id"], message_id, user.id, body.body,
        )
        blocks = (
            await insert_mention_blocks(conn, row["id"], parent["channel_id"], body.mentions)
            if parent["channel_id"] is not None else []
        )
    return _message_out({**dict(row), "sender_name": user.name, "sender_picture_url": user.picture_url}, blocks)
