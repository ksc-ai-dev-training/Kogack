# A-50〜A-52（詳細設計書 API設計4.9節、基本設計書5.15節 F-35 送信予約）
# 実際の発言化はservices/scheduled_dispatcher.pyが30秒間隔ポーリングで行う。このルーターは
# scheduled_messagesへのCRUDのみを担当する。@メンションの構造化（T-07 message_blocks）は
# A-11/A-14と異なりこのスライスでは対象外（T-18にmentions列を追加していないため。本文中に
# 「@氏名」と入力すること自体はできるが、送信時にハイライト表示や参照解決はされないプレーン
# テキストのまま発言化される）。ファイル添付との併用も対象外（要件定義書3.2節）。
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_helpers import CurrentUser, require_auth
from database import get_pool

router = APIRouter(prefix="/api/scheduled-messages", tags=["scheduled-messages"])


def _out(row) -> dict:
    return {
        "id": str(row["id"]),
        "channel_id": str(row["channel_id"]) if row["channel_id"] is not None else None,
        "dm_id": str(row["dm_id"]) if row["dm_id"] is not None else None,
        "thread_parent_id": str(row["thread_parent_id"]) if row["thread_parent_id"] is not None else None,
        "body": row["body"],
        "scheduled_at": row["scheduled_at"].isoformat(),
        "status": row["status"],
    }


class CreateScheduledMessageRequest(BaseModel):
    channel_id: str | None = None
    dm_id: str | None = None
    thread_parent_id: str | None = None
    body: str = Field(min_length=1, max_length=4000)
    scheduled_at: str


@router.post("", status_code=201)
async def create_scheduled_message(
    body: CreateScheduledMessageRequest, user: CurrentUser = Depends(require_auth),
):
    """A-50: 送信予約の作成。チャンネル・DM・スレッド返信いずれの投稿欄からも呼ばれる
    （channel_id/dm_idはT-05と同じくどちらか一方のみ指定。thread_parent_idは任意）。"""
    if (body.channel_id is None) == (body.dm_id is None):
        raise HTTPException(422, detail="channel_idかdm_idのいずれか一方を指定してください")
    try:
        scheduled_at = datetime.fromisoformat(body.scheduled_at.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(422, detail="scheduled_atの形式が不正です")
    if scheduled_at <= datetime.now(timezone.utc):
        raise HTTPException(400, detail="未来の日時を指定してください")

    pool = get_pool()
    channel_id = int(body.channel_id) if body.channel_id else None
    dm_id = int(body.dm_id) if body.dm_id else None
    thread_parent_id = int(body.thread_parent_id) if body.thread_parent_id else None

    # 投稿API（A-11/A-19）と同じ参加者チェック（総論5.1節・5.3節）。channel_id/dm_idはURLパスの
    # パラメータではなくボディの値のため、require_channel_member/require_dm_memberは使えず
    # ここで同じ判定を再現する（A-12削除APIと同じ考え方）。
    if channel_id is not None:
        channel = await pool.fetchrow("SELECT is_public FROM channels WHERE id = $1", channel_id)
        if channel is None:
            raise HTTPException(404, detail="見つかりません")
        is_member = await pool.fetchval(
            "SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)",
            channel_id, user.id,
        )
        if not is_member:
            if channel["is_public"]:
                raise HTTPException(403, detail="権限がありません")
            raise HTTPException(404, detail="見つかりません")
    else:
        is_member = await pool.fetchval(
            "SELECT EXISTS(SELECT 1 FROM direct_message_members WHERE dm_id = $1 AND user_id = $2)",
            dm_id, user.id,
        )
        if not is_member:
            raise HTTPException(404, detail="見つかりません")

    row = await pool.fetchrow(
        """INSERT INTO scheduled_messages (channel_id, dm_id, thread_parent_id, sender_user_id, body, scheduled_at)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *""",
        channel_id, dm_id, thread_parent_id, user.id, body.body, scheduled_at,
    )
    return _out(row)


@router.get("")
async def list_scheduled_messages(user: CurrentUser = Depends(require_auth)):
    """A-51: 自分が予約したメッセージ一覧（pendingのみ）。補足04モーダルとヘッダーバッジで
    useScheduledMessages()を共有する（05-3画面設計11.4節「更新の反映」）。"""
    rows = await get_pool().fetch(
        """SELECT * FROM scheduled_messages WHERE sender_user_id = $1 AND status = 'pending'
           ORDER BY scheduled_at ASC""",
        user.id,
    )
    return {"items": [_out(r) for r in rows]}


@router.delete("/{scheduled_id}", status_code=204)
async def cancel_scheduled_message(scheduled_id: int, user: CurrentUser = Depends(require_auth)):
    """A-52: 予約をキャンセル。予約した本人のみ実行できる。存在しない・他人の予約・
    既にsent/cancelled済みの場合はいずれも404（存在を伏せる）。"""
    updated = await get_pool().fetchval(
        """UPDATE scheduled_messages SET status = 'cancelled'
           WHERE id = $1 AND sender_user_id = $2 AND status = 'pending' RETURNING id""",
        scheduled_id, user.id,
    )
    if updated is None:
        raise HTTPException(404, detail="見つかりません")
