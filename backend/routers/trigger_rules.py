# A-63〜A-66（詳細設計書 API設計、基本設計書5.19節 F-38 トリガーによる自動応答）。S-06「自動応答
# トリガー」タブに対応。実際の判定・発言化はA-11（channels.pyのpost_message）から呼ばれる
# services/trigger_matcher.pyが同期的に行う。このルーターはtrigger_rulesへのCRUDのみを担当する。
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_helpers import CurrentUser, require_channel_admin
from database import get_pool

router = APIRouter(prefix="/api/channels", tags=["trigger-rules"])


def _out(row) -> dict:
    return {
        "id": str(row["id"]),
        "channel_id": str(row["channel_id"]),
        "trigger_type": row["trigger_type"],
        "trigger_value": row["trigger_value"],
        "action_type": row["action_type"],
        "action_body": row["action_body"],
        "bot_display_name": row["bot_display_name"],
        "bot_icon": row["bot_icon"],
        "bot_icon_url": row["bot_icon_url"],
        "is_active": row["is_active"],
        "created_at": row["created_at"].isoformat(),
    }


@router.get("/{channel_id}/trigger-rules")
async def list_trigger_rules(channel_id: int, user: CurrentUser = Depends(require_channel_admin)):
    """A-63: このチャンネルの自動応答トリガー一覧（作成日時の新しい順）"""
    rows = await get_pool().fetch(
        "SELECT * FROM trigger_rules WHERE channel_id = $1 ORDER BY created_at DESC", channel_id
    )
    return {"items": [_out(r) for r in rows]}


class CreateTriggerRuleRequest(BaseModel):
    trigger_type: str = Field(pattern="^(keyword|emoji)$")
    trigger_value: str = Field(min_length=1, max_length=100)
    action_body: str = Field(min_length=1, max_length=4000)
    bot_display_name: str | None = Field(default=None, max_length=100)
    bot_icon: str | None = Field(default=None, max_length=8)
    bot_icon_url: str | None = None


@router.post("/{channel_id}/trigger-rules", status_code=201)
async def create_trigger_rule(
    channel_id: int, body: CreateTriggerRuleRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-64: 自動応答トリガーを作成。action_typeは'post_message'固定（05-1_詳細設計書_DB設計.html
    3.16節）。bot_display_name未指定時は既定値「自動応答Bot」を補う。"""
    display_name = body.bot_display_name or "自動応答Bot"
    row = await get_pool().fetchrow(
        """INSERT INTO trigger_rules
               (channel_id, created_by, trigger_type, trigger_value, action_body,
                bot_display_name, bot_icon, bot_icon_url)
           VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, '⚡'), $8)
           RETURNING *""",
        channel_id, user.id, body.trigger_type, body.trigger_value, body.action_body,
        display_name, body.bot_icon, body.bot_icon_url,
    )
    return _out(row)


class UpdateTriggerRuleRequest(BaseModel):
    trigger_type: str | None = Field(default=None, pattern="^(keyword|emoji)$")
    trigger_value: str | None = Field(default=None, min_length=1, max_length=100)
    action_body: str | None = Field(default=None, min_length=1, max_length=4000)
    bot_display_name: str | None = Field(default=None, min_length=1, max_length=100)
    bot_icon: str | None = Field(default=None, max_length=8)
    bot_icon_url: str | None = None
    is_active: bool | None = None


@router.put("/{channel_id}/trigger-rules/{rule_id}")
async def update_trigger_rule(
    channel_id: int, rule_id: int, body: UpdateTriggerRuleRequest,
    user: CurrentUser = Depends(require_channel_admin),
):
    """A-65: 自動応答トリガーを更新（部分更新。is_activeのみ送ると一時停止/再開のトグルになる）"""
    row = await get_pool().fetchrow(
        """UPDATE trigger_rules SET
               trigger_type = COALESCE($3, trigger_type),
               trigger_value = COALESCE($4, trigger_value),
               action_body = COALESCE($5, action_body),
               bot_display_name = COALESCE($6, bot_display_name),
               bot_icon = COALESCE($7, bot_icon),
               bot_icon_url = COALESCE($8, bot_icon_url),
               is_active = COALESCE($9, is_active),
               updated_by = $10,
               updated_at = now()
           WHERE id = $1 AND channel_id = $2 RETURNING *""",
        rule_id, channel_id, body.trigger_type, body.trigger_value, body.action_body,
        body.bot_display_name, body.bot_icon, body.bot_icon_url, body.is_active, user.id,
    )
    if row is None:
        raise HTTPException(404, detail="見つかりません")
    return _out(row)


@router.delete("/{channel_id}/trigger-rules/{rule_id}", status_code=204)
async def delete_trigger_rule(
    channel_id: int, rule_id: int, user: CurrentUser = Depends(require_channel_admin),
):
    """A-66: 自動応答トリガーを削除。既に投稿済みのT-05発言は削除しない
    （messages.trigger_rule_idはON DELETE SET NULLのため、削除後は参照が外れるだけで発言自体は残る）。"""
    deleted = await get_pool().fetchval(
        "DELETE FROM trigger_rules WHERE id = $1 AND channel_id = $2 RETURNING id", rule_id, channel_id
    )
    if deleted is None:
        raise HTTPException(404, detail="見つかりません")
