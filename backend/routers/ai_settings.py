# A-23〜A-26（詳細設計書 API設計4.6節、基本設計書8.3節）。S-06 AI設定タブのうち「基本設定」
# 「キャラクタ」「振る舞い定義」の3タブに対応する。A-27（参照ドキュメント範囲）・A-28〜A-30
# （スキル）・A-31（自動対応範囲）はドキュメントQ&A・自動対応分類（層2/層3）が未実装のため
# 対象外（CLAUDE.md実装状況節）。
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from auth_helpers import CurrentUser, require_channel_admin
from database import get_pool

router = APIRouter(prefix="/api/channels", tags=["ai-settings"])


def _out(row) -> dict:
    return {
        "channel_id": str(row["channel_id"]),
        "is_ai_enabled": row["is_ai_enabled"],
        "persona_name": row["persona_name"],
        "persona_icon_url": row["persona_icon_url"],
        "persona_tone": row["persona_tone"],
        "behavior_prompt": row["behavior_prompt"],
        "reaction_mode": row["reaction_mode"],
    }


async def _get_or_create(channel_id: int) -> dict:
    """T-08は既定値でチャンネル作成時（A-07）に1行作成する想定だが、この機能より前に
    作成された既存チャンネルには行が無いため、初回アクセス時に既定値で補完する。"""
    pool = get_pool()
    row = await pool.fetchrow("SELECT * FROM channel_ai_settings WHERE channel_id = $1", channel_id)
    if row is None:
        row = await pool.fetchrow(
            "INSERT INTO channel_ai_settings (channel_id) VALUES ($1) RETURNING *", channel_id
        )
    return dict(row)


@router.get("/{channel_id}/ai-settings")
async def get_ai_settings(channel_id: int, user: CurrentUser = Depends(require_channel_admin)):
    """A-23: AI設定一括取得（S-06）"""
    return _out(await _get_or_create(channel_id))


class UpdateGeneralRequest(BaseModel):
    is_ai_enabled: bool


@router.put("/{channel_id}/ai-settings/general")
async def update_general(
    channel_id: int, body: UpdateGeneralRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-24: AI有効/無効の切り替え。反応モード（reaction_mode）の変更UIはこのスライスでは
    対象外（常に既定のmention_onlyのまま。基本設計書8.1節「投稿に自ら反応」は次スライス以降）"""
    await _get_or_create(channel_id)
    row = await get_pool().fetchrow(
        """UPDATE channel_ai_settings SET is_ai_enabled = $2, updated_by = $3, updated_at = now()
           WHERE channel_id = $1 RETURNING *""",
        channel_id, body.is_ai_enabled, user.id,
    )
    return _out(row)


class UpdateCharacterRequest(BaseModel):
    persona_name: str = Field(min_length=1, max_length=100)
    persona_icon_url: str | None = None
    persona_tone: str | None = Field(default=None, max_length=500)


@router.put("/{channel_id}/ai-settings/character")
async def update_character(
    channel_id: int, body: UpdateCharacterRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-25: キャラクタ（名前・アイコン・口調）更新。アイコンはA-61でアップロード済みのURLを
    persona_icon_urlとして指定する（F-10）"""
    await _get_or_create(channel_id)
    row = await get_pool().fetchrow(
        """UPDATE channel_ai_settings
           SET persona_name = $2, persona_icon_url = $3, persona_tone = $4,
               updated_by = $5, updated_at = now()
           WHERE channel_id = $1 RETURNING *""",
        channel_id, body.persona_name, body.persona_icon_url, body.persona_tone, user.id,
    )
    return _out(row)


class UpdatePromptRequest(BaseModel):
    behavior_prompt: str = Field(default="", max_length=8000)


@router.put("/{channel_id}/ai-settings/prompt")
async def update_prompt(
    channel_id: int, body: UpdatePromptRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-26: 振る舞い定義の更新（上書き保存、過去バージョンは持たない）。監査ログへの記録
    （基本設計書8.3節）はT-16 audit_logs・S-08監査ログタブが未実装のためこのスライスでは対象外"""
    await _get_or_create(channel_id)
    row = await get_pool().fetchrow(
        """UPDATE channel_ai_settings SET behavior_prompt = $2, updated_by = $3, updated_at = now()
           WHERE channel_id = $1 RETURNING *""",
        channel_id, body.behavior_prompt, user.id,
    )
    return _out(row)
