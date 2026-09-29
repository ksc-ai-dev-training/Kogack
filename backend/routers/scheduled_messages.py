# A-50〜A-52（詳細設計書 API設計4.9節、基本設計書5.15節 F-35 送信予約）
# 実際の発言化はservices/scheduled_dispatcher.pyが30秒間隔ポーリングで行う。このルーターは
# scheduled_messagesへのCRUDのみを担当する。@メンションの構造化（T-07 message_blocks）は
# A-11/A-14と同じMentionInputを受け取り、T-18のmentions列（JSONB）へそのまま保持する。
# 参加者であることの検証（insert_mention_blocks）は予約時点ではなく発言化のタイミング
# （scheduled_dispatcher.py）で行う。予約から送信までの間に対象者がチャンネルを抜ける可能性が
# あり、A-11/A-14が「投稿時点の参加者」を基準にするのと同じ考え方を送信時点に合わせるため。
# DM宛ての予約もA-19と同じくDM参加者をメンション候補元として保持する（DMのメンションは
# 2026-09-04から対応済みで、従来ここだけ常に空として捨てていた）。
# ファイル添付との併用は引き続き対象外（要件定義書3.2節）。
import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_helpers import CurrentUser, require_auth
from database import get_pool
from mentions import MentionInput

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
    mentions: list[MentionInput] = []
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
    try:
        channel_id = int(body.channel_id) if body.channel_id else None
        dm_id = int(body.dm_id) if body.dm_id else None
        thread_parent_id = int(body.thread_parent_id) if body.thread_parent_id else None
    except ValueError:
        raise HTTPException(422, detail="IDは数値で指定してください")

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

    if thread_parent_id is not None:
        # バグ修正（2026-09-29）: 従来はthread_parent_idを一切検証しておらず、自分のチャンネルを
        # 宛先にしたまま「参加していない非公開チャンネル・DMの発言」を返信先に指定できた。送信時に
        # その他人のスレッドへ返信が入り込むうえ、@AI名を含めると他人のスレッドの会話がAIへ渡され、
        # 自分のチャンネルのAI発言・A-76（送信内容の確認）経由で読み出せてしまっていた。
        # A-14（require_thread_access＋元発言からchannel_id/dm_idを引き継ぐ）と同じく、返信先が
        # 宛先と同じチャンネル/DMにある削除されていない本体の発言であることを要求する
        # （上の参加者チェックを通過済みなので、ここで一致すれば返信先も閲覧可能と言える）
        parent = await pool.fetchrow(
            "SELECT channel_id, dm_id, thread_parent_id FROM messages WHERE id = $1 AND deleted_at IS NULL",
            thread_parent_id,
        )
        if (
            parent is None or parent["thread_parent_id"] is not None
            or parent["channel_id"] != channel_id or parent["dm_id"] != dm_id
        ):
            raise HTTPException(404, detail="返信先の発言が見つかりません")

    row = await pool.fetchrow(
        """INSERT INTO scheduled_messages
               (channel_id, dm_id, thread_parent_id, sender_user_id, body, mentions, scheduled_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7) RETURNING *""",
        channel_id, dm_id, thread_parent_id, user.id, body.body,
        json.dumps([m.model_dump() for m in body.mentions]), scheduled_at,
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
