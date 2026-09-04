# A-16〜A-19（詳細設計書 API設計4.4節、総論5.1節）
# グループDM対応。参加者は開始時に固定（開始後の追加・削除は対象外、05-1_詳細設計書_DB設計.html 3.17節）。
# 自分専用DM（F-05、direct_message_membersが自分1行のみ）にも対応する
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from attachments import AttachmentInput, fetch_attachments_grouped, insert_attachments
from auth_helpers import CurrentUser, require_auth, require_dm_member
from database import get_pool

router = APIRouter(prefix="/api/dms", tags=["dms"])


async def _dm_out(pool, dm_id: int, created_at, self_user_id: int, unread_count: int = 0) -> dict:
    all_member_ids = {
        r["user_id"]
        for r in await pool.fetch("SELECT user_id FROM direct_message_members WHERE dm_id = $1", dm_id)
    }
    is_self = all_member_ids == {self_user_id}
    # 通常は表示用に「自分以外の相手」を返すが、自分専用DM（F-05、参加者が自分1人だけ）は
    # 除外すると空になってしまうため、その場合のみ自分自身をmembersに含める
    target_ids = all_member_ids - {self_user_id} if not is_self else all_member_ids
    members = await pool.fetch(
        "SELECT id, name, picture_url FROM users WHERE id = ANY($1::bigint[]) ORDER BY name",
        list(target_ids),
    )
    return {
        "id": str(dm_id),
        "members": [
            {"id": str(r["id"]), "name": r["name"], "picture_url": r["picture_url"]} for r in members
        ],
        "is_self": is_self,
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
    """A-17: DM開始。呼び出し元を加えた参加者集合が既存DMと完全一致すればそれを返す（200相当だがcreatedで判別）。
    member_user_idsが自分のidのみ（＝自分を除いた集合が空）の場合は自分専用DM（F-05、メモ・下書き・
    To-do用途）として扱う。member_user_ids自体はField(min_length=1)で必ず1件以上のため、
    「自分以外を1件も指定しなかった」＝「明示的に自分だけを指定した」と解釈できる"""
    pool = get_pool()
    try:
        other_ids = {int(v) for v in body.member_user_ids}
    except ValueError:
        raise HTTPException(422, detail="不正なuser_idです")
    other_ids.discard(user.id)

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


def _message_out(row, attachments: list[dict] | None = None) -> dict:
    return {
        "id": str(row["id"]),
        "dm_id": str(row["dm_id"]),
        "sender_type": row["sender_type"],
        "sender_user_id": str(row["sender_user_id"]) if row["sender_user_id"] is not None else None,
        # BOT/AI発言（いずれもsender_user_id無し）はbot_display_nameを表示名として使う（F-36/F-38/F-43。
        # AI応答は実際にはチャンネルのみのためDMでは発生しないが、他2ルーターと同じ分岐に揃えておく）
        "sender_name": row["bot_display_name"] if row["sender_type"] in ("bot", "ai") else row["sender_name"],
        # AI発言はbot_icon_urlにペルソナアイコンのスナップショットを持つ（services/ai_agent.py。
        # ただしAI応答はチャンネルのみ対応のためDMでは実際には発生しない）。BOT発言は
        # sender_user_idが無いためJOIN結果が自然にNULLになる（アイコン未実装、F-36/F-38）
        "sender_picture_url": row["bot_icon_url"] if row["sender_type"] in ("ai", "bot") else row["sender_picture_url"],
        "bot_icon": row["bot_icon"] if row["sender_type"] == "bot" else None,
        "body": row["body"],
        "generation_status": row["generation_status"],
        "thread_reply_count": row["thread_reply_count"],
        # F-14 やりとりの要約はチャンネルのみ対応（A-15がチャンネル専用API）のためDMでは常にfalseだが、
        # 他2ルーターと同じ分岐に揃えておく
        "is_summary": row["is_summary"],
        # F-41 @メンションはチャンネルのみ対応（候補元のA-46がチャンネル参加者一覧のため）。
        # DM発言は常に空配列とし、フロント側でMessage型の形を揃える。添付ファイル（F-07）は
        # メンションと異なり候補元に依存しないためDMでも対応する。
        "blocks": [],
        "attachments": attachments or [],
        "created_at": row["created_at"].isoformat(),
        # channels.pyと同じ理由でsinceポーリングの差分取得判定に使う（下記list_messages参照）
        "updated_at": row["updated_at"].isoformat(),
    }


_MESSAGES_SELECT = """SELECT m.*, u.name AS sender_name, u.picture_url AS sender_picture_url,
       (SELECT count(*) FROM messages r WHERE r.thread_parent_id = m.id AND r.deleted_at IS NULL)
           AS thread_reply_count
   FROM messages m
   LEFT JOIN users u ON u.id = m.sender_user_id"""


AROUND_WINDOW = 25  # channels.pyと同じ（検索結果からのハイライトジャンプで前後何件ずつ取るか）


async def _around_rows(pool, dm_id: int, around_message_id: int):
    """channels.py の _around_rows と同じ考え方（検索結果クリックでのハイライトジャンプ用）。
    対象の発言が見つからない場合はNoneを返す"""
    anchor = await pool.fetchrow(
        """SELECT created_at FROM messages
           WHERE id = $1 AND dm_id = $2 AND thread_parent_id IS NULL AND deleted_at IS NULL""",
        around_message_id, dm_id,
    )
    if anchor is None:
        return None
    before = list(reversed(await pool.fetch(
        f"""{_MESSAGES_SELECT}
           WHERE m.dm_id = $1 AND m.deleted_at IS NULL AND m.thread_parent_id IS NULL
             AND m.created_at <= $2
           ORDER BY m.created_at DESC LIMIT $3""",
        dm_id, anchor["created_at"], AROUND_WINDOW,
    )))
    after = await pool.fetch(
        f"""{_MESSAGES_SELECT}
           WHERE m.dm_id = $1 AND m.deleted_at IS NULL AND m.thread_parent_id IS NULL
             AND m.created_at > $2
           ORDER BY m.created_at ASC LIMIT $3""",
        dm_id, anchor["created_at"], AROUND_WINDOW,
    )
    return before + list(after)


@router.get("/{dm_id}/messages")
async def list_messages(
    dm_id: int, since: str | None = None, limit: int = 50, around: int | None = None,
    user: CurrentUser = Depends(require_dm_member),
):
    """A-18: 履歴取得。channels.list_messagesと同じsince差分ポーリング方式（基本設計書9.1節）。
    aroundはchannels.list_messagesと同じくハイライトジャンプ用（ユーザーからの明示的な要望）。
    sinceの判定はcreated_atではなくupdated_atで行う（channels.list_messagesと同じ理由・
    2026-09-04のバグ修正。DM発言は現状AI応答が無いため実害は起きていなかったが、他2ルーターと
    挙動を揃えておく）"""
    pool = get_pool()
    if since:
        since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        rows = await pool.fetch(
            f"""{_MESSAGES_SELECT}
               WHERE m.dm_id = $1 AND m.deleted_at IS NULL AND m.thread_parent_id IS NULL
                 AND m.updated_at > $2
               ORDER BY m.updated_at ASC""",
            dm_id, since_dt,
        )
        attachments_by_message = await fetch_attachments_grouped(pool, [r["id"] for r in rows])
        return {
            "items": [_message_out(r, attachments_by_message.get(r["id"])) for r in rows], "has_more": False,
        }
    if around:
        rows = await _around_rows(pool, dm_id, around)
        if rows is None:
            raise HTTPException(404, detail="発言が見つかりません")
        attachments_by_message = await fetch_attachments_grouped(pool, [r["id"] for r in rows])
        return {
            "items": [_message_out(r, attachments_by_message.get(r["id"])) for r in rows], "has_more": False,
        }
    rows = await pool.fetch(
        f"""{_MESSAGES_SELECT}
           WHERE m.dm_id = $1 AND m.deleted_at IS NULL AND m.thread_parent_id IS NULL
           ORDER BY m.created_at DESC LIMIT $2""",
        dm_id, limit,
    )
    attachments_by_message = await fetch_attachments_grouped(pool, [r["id"] for r in rows])
    return {
        "items": [_message_out(r, attachments_by_message.get(r["id"])) for r in reversed(rows)],
        "has_more": len(rows) == limit,
    }


class PostMessageRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    attachments: list[AttachmentInput] = []


@router.post("/{dm_id}/messages", status_code=201)
async def post_message(dm_id: int, body: PostMessageRequest, user: CurrentUser = Depends(require_dm_member)):
    """A-19: メッセージ投稿。添付ファイル（F-07）はチャンネルと同じくA-21で保存済みの実体をT-06へ紐づける"""
    pool = get_pool()
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            """INSERT INTO messages (dm_id, sender_type, sender_user_id, body)
               VALUES ($1, 'human', $2, $3) RETURNING *""",
            dm_id, user.id, body.body,
        )
        attachments = await insert_attachments(conn, row["id"], user.id, body.attachments)
    return _message_out(
        {**dict(row), "sender_name": user.name, "sender_picture_url": user.picture_url, "thread_reply_count": 0},
        attachments,
    )
