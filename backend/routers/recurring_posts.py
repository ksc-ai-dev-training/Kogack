# A-53〜A-56（詳細設計書 API設計、基本設計書5.16節 F-36 定期投稿）。S-06「定期投稿」タブに対応。
# 実際の発言化はservices/scheduled_dispatcher.pyがF-35と同じ30秒間隔ポーリングで行う。このルーターは
# recurring_postsへのCRUDのみを担当する。
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_helpers import CurrentUser, require_channel_admin
from database import get_pool

router = APIRouter(prefix="/api/channels", tags=["recurring-posts"])


def _out(row) -> dict:
    return {
        "id": str(row["id"]),
        "channel_id": str(row["channel_id"]),
        "body": row["body"],
        "bot_display_name": row["bot_display_name"],
        "bot_icon": row["bot_icon"],
        "bot_icon_url": row["bot_icon_url"],
        "frequency": row["frequency"],
        "anchor_at": row["anchor_at"].isoformat(),
        "next_run_at": row["next_run_at"].isoformat(),
        "is_active": row["is_active"],
        "last_sent_at": row["last_sent_at"].isoformat() if row["last_sent_at"] else None,
        "created_at": row["created_at"].isoformat(),
    }


@router.get("/{channel_id}/recurring-posts")
async def list_recurring_posts(channel_id: int, user: CurrentUser = Depends(require_channel_admin)):
    """A-53: このチャンネルの定期投稿ルール一覧（作成日時の新しい順）"""
    rows = await get_pool().fetch(
        "SELECT * FROM recurring_posts WHERE channel_id = $1 ORDER BY created_at DESC", channel_id
    )
    return {"items": [_out(r) for r in rows]}


class CreateRecurringPostRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    bot_display_name: str | None = Field(default=None, max_length=100)
    bot_icon: str | None = Field(default=None, max_length=8)
    bot_icon_url: str | None = None
    frequency: str = Field(pattern="^(once|daily|weekly|monthly)$")
    anchor_at: str


@router.post("/{channel_id}/recurring-posts", status_code=201)
async def create_recurring_post(
    channel_id: int, body: CreateRecurringPostRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-54: 定期投稿ルールを作成。bot_display_name未指定時は既定値「お知らせBot」を補う
    （05-1_詳細設計書_DB設計.html 3.14節）。next_run_atの初期値はanchor_atそのもの（初回はその時刻に
    送信され、以後frequencyに応じてservices/scheduled_dispatcher.pyが次回時刻を計算する）。"""
    try:
        anchor_at = datetime.fromisoformat(body.anchor_at.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(422, detail="anchor_atの形式が不正です")
    if anchor_at <= datetime.now(timezone.utc):
        raise HTTPException(400, detail="未来の日時を指定してください")

    display_name = body.bot_display_name or "お知らせBot"
    # 画像アップロード済みならbot_icon_urlを優先表示するため、bot_iconは指定が無ければ既定の📌のまま
    # （画面設計11.6節 Avatarコンポーネント定義と同じ「画像優先→絵文字フォールバック」の考え方）
    row = await get_pool().fetchrow(
        """INSERT INTO recurring_posts
               (channel_id, created_by, body, bot_display_name, bot_icon, bot_icon_url,
                frequency, anchor_at, next_run_at)
           VALUES ($1, $2, $3, $4, COALESCE($5, '📌'), $6, $7, $8, $8)
           RETURNING *""",
        channel_id, user.id, body.body, display_name, body.bot_icon, body.bot_icon_url,
        body.frequency, anchor_at,
    )
    return _out(row)


class UpdateRecurringPostRequest(BaseModel):
    body: str | None = Field(default=None, min_length=1, max_length=4000)
    bot_display_name: str | None = Field(default=None, min_length=1, max_length=100)
    bot_icon: str | None = Field(default=None, max_length=8)
    bot_icon_url: str | None = None
    frequency: str | None = Field(default=None, pattern="^(once|daily|weekly|monthly)$")
    anchor_at: str | None = None
    is_active: bool | None = None


@router.put("/{channel_id}/recurring-posts/{rule_id}")
async def update_recurring_post(
    channel_id: int, rule_id: int, body: UpdateRecurringPostRequest,
    user: CurrentUser = Depends(require_channel_admin),
):
    """A-55: 定期投稿ルールを更新（部分更新。is_activeのみ送ると一時停止/再開のトグルになる）。
    anchor_atを変更した場合はnext_run_atも同じ値へ再設定する（頻度の起点をやり直す）。"""
    existing = await get_pool().fetchrow(
        "SELECT * FROM recurring_posts WHERE id = $1 AND channel_id = $2", rule_id, channel_id
    )
    if existing is None:
        raise HTTPException(404, detail="見つかりません")

    anchor_at = existing["anchor_at"]
    next_run_at = existing["next_run_at"]
    if body.anchor_at is not None:
        try:
            anchor_at = datetime.fromisoformat(body.anchor_at.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(422, detail="anchor_atの形式が不正です")
        next_run_at = anchor_at

    row = await get_pool().fetchrow(
        """UPDATE recurring_posts SET
               body = COALESCE($3, body),
               bot_display_name = COALESCE($4, bot_display_name),
               bot_icon = COALESCE($5, bot_icon),
               bot_icon_url = COALESCE($6, bot_icon_url),
               frequency = COALESCE($7, frequency),
               anchor_at = $8,
               next_run_at = $9,
               is_active = COALESCE($10, is_active),
               updated_by = $11,
               updated_at = now()
           WHERE id = $1 AND channel_id = $2 RETURNING *""",
        rule_id, channel_id, body.body, body.bot_display_name, body.bot_icon, body.bot_icon_url,
        body.frequency, anchor_at, next_run_at, body.is_active, user.id,
    )
    return _out(row)


@router.delete("/{channel_id}/recurring-posts/{rule_id}", status_code=204)
async def delete_recurring_post(
    channel_id: int, rule_id: int, user: CurrentUser = Depends(require_channel_admin),
):
    """A-56: 定期投稿ルールを削除。既に送信済みのT-05発言は削除しない
    （messages.recurring_post_idはON DELETE SET NULLのため、削除後は参照が外れるだけで発言自体は残る）。"""
    deleted = await get_pool().fetchval(
        "DELETE FROM recurring_posts WHERE id = $1 AND channel_id = $2 RETURNING id", rule_id, channel_id
    )
    if deleted is None:
        raise HTTPException(404, detail="見つかりません")
