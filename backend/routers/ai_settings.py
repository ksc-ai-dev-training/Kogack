# A-23〜A-30, A-45（詳細設計書 API設計4.6節、基本設計書8.3節）。S-06 AI設定タブのうち「基本設定」
# 「キャラクタ」「振る舞い定義」「参照ドキュメント範囲」「スキル」の5タブに対応する。A-31
# （自動対応範囲）は自動対応分類（層3）が未実装のため対象外（CLAUDE.md実装状況節）。
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import audit_log
from auth_helpers import CurrentUser, require_channel_admin
from database import get_pool

router = APIRouter(prefix="/api/channels", tags=["ai-settings"])


def _out(row, folder_ids: list[str], skills: list[dict]) -> dict:
    return {
        "channel_id": str(row["channel_id"]),
        "is_ai_enabled": row["is_ai_enabled"],
        "persona_name": row["persona_name"],
        "persona_icon_url": row["persona_icon_url"],
        "persona_tone": row["persona_tone"],
        "behavior_prompt": row["behavior_prompt"],
        "reaction_mode": row["reaction_mode"],
        "out_of_scope_policy": row["out_of_scope_policy"],
        "folder_ids": folder_ids,
        "skills": skills,
        "fallback_handoff_user_id": (
            str(row["fallback_handoff_user_id"]) if row["fallback_handoff_user_id"] is not None else None
        ),
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


async def _folder_ids(channel_id: int) -> list[str]:
    rows = await get_pool().fetch(
        "SELECT folder_id FROM channel_doc_folders WHERE channel_id = $1 ORDER BY folder_id", channel_id
    )
    return [str(r["folder_id"]) for r in rows]


async def _skills(channel_id: int) -> list[dict]:
    rows = await get_pool().fetch(
        "SELECT id, title, instructions FROM channel_skills WHERE channel_id = $1 ORDER BY created_at", channel_id
    )
    return [{"id": str(r["id"]), "title": r["title"], "instructions": r["instructions"]} for r in rows]


@router.get("/{channel_id}/ai-settings")
async def get_ai_settings(channel_id: int, user: CurrentUser = Depends(require_channel_admin)):
    """A-23: AI設定一括取得（S-06）"""
    settings = await _get_or_create(channel_id)
    return _out(settings, await _folder_ids(channel_id), await _skills(channel_id))


class UpdateGeneralRequest(BaseModel):
    is_ai_enabled: bool


@router.put("/{channel_id}/ai-settings/general")
async def update_general(
    channel_id: int, body: UpdateGeneralRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-24: AI有効/無効の切り替え。反応モード（reaction_mode）の変更UIはこのスライスでは
    対象外（常に既定のmention_onlyのまま。基本設計書8.1節「投稿に自ら反応」は次スライス以降）"""
    await _get_or_create(channel_id)
    pool = get_pool()
    row = await pool.fetchrow(
        """UPDATE channel_ai_settings SET is_ai_enabled = $2, updated_by = $3, updated_at = now()
           WHERE channel_id = $1 RETURNING *""",
        channel_id, body.is_ai_enabled, user.id,
    )
    await audit_log.record(
        pool, "channel_ai_setting_change", user.id,
        f"AIを{'有効' if body.is_ai_enabled else '無効'}にしました",
        target_channel_id=channel_id, target_field="is_ai_enabled",
    )
    return _out(row, await _folder_ids(channel_id), await _skills(channel_id))


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
    pool = get_pool()
    row = await pool.fetchrow(
        """UPDATE channel_ai_settings
           SET persona_name = $2, persona_icon_url = $3, persona_tone = $4,
               updated_by = $5, updated_at = now()
           WHERE channel_id = $1 RETURNING *""",
        channel_id, body.persona_name, body.persona_icon_url, body.persona_tone, user.id,
    )
    await audit_log.record(
        pool, "channel_ai_setting_change", user.id, "キャラクタ設定を更新しました",
        target_channel_id=channel_id, target_field="character",
    )
    return _out(row, await _folder_ids(channel_id), await _skills(channel_id))


class UpdatePromptRequest(BaseModel):
    behavior_prompt: str = Field(default="", max_length=8000)


@router.put("/{channel_id}/ai-settings/prompt")
async def update_prompt(
    channel_id: int, body: UpdatePromptRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-26: 振る舞い定義の更新（上書き保存、過去バージョンは持たない）。T-16 audit_logsへ記録する
    （基本設計書8.3節、S-08監査ログタブ）。本文差分は保持せず、更新があったことのみ記録する"""
    await _get_or_create(channel_id)
    pool = get_pool()
    row = await pool.fetchrow(
        """UPDATE channel_ai_settings SET behavior_prompt = $2, updated_by = $3, updated_at = now()
           WHERE channel_id = $1 RETURNING *""",
        channel_id, body.behavior_prompt, user.id,
    )
    await audit_log.record(
        pool, "channel_ai_setting_change", user.id, "振る舞い定義を更新しました",
        target_channel_id=channel_id, target_field="behavior_prompt",
    )
    return _out(row, await _folder_ids(channel_id), await _skills(channel_id))


class UpdateDocScopeRequest(BaseModel):
    folder_ids: list[str] = Field(default_factory=list)
    out_of_scope_policy: str = "strict"


@router.put("/{channel_id}/ai-settings/doc-scope")
async def update_doc_scope(
    channel_id: int, body: UpdateDocScopeRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-27: 参照ドキュメント範囲（F-11・F-22）。folder_idsは送信された集合でT-10を洗い替える。
    S-08で削除済み・存在しないfolder_idは黙って無視する（F-41のメンション対象外指定と同じ考え方で、
    設定保存自体を失敗させない）。実際のDrive同期・索引・AI検索（search_documentsツール）は
    次スライスで実装するため、この設定は現時点ではAI応答に反映されない（CLAUDE.md実装状況節）"""
    if body.out_of_scope_policy not in ("strict", "general"):
        raise HTTPException(422, detail="out_of_scope_policyはstrict/generalのいずれかです")
    try:
        requested_ids = [int(x) for x in body.folder_ids]
    except ValueError:
        raise HTTPException(422, detail="folder_idsは数値のIDです")

    await _get_or_create(channel_id)
    pool = get_pool()
    async with pool.acquire() as conn, conn.transaction():
        valid_ids = {
            r["id"] for r in await conn.fetch("SELECT id FROM doc_folders WHERE id = ANY($1::bigint[])", requested_ids)
        }
        await conn.execute("DELETE FROM channel_doc_folders WHERE channel_id = $1", channel_id)
        if valid_ids:
            await conn.executemany(
                "INSERT INTO channel_doc_folders (channel_id, folder_id) VALUES ($1, $2)",
                [(channel_id, fid) for fid in valid_ids],
            )
        row = await conn.fetchrow(
            """UPDATE channel_ai_settings SET out_of_scope_policy = $2, updated_by = $3, updated_at = now()
               WHERE channel_id = $1 RETURNING *""",
            channel_id, body.out_of_scope_policy, user.id,
        )
        await audit_log.record(
            conn, "channel_ai_setting_change", user.id, "参照ドキュメント範囲を更新しました",
            target_channel_id=channel_id, target_field="doc_scope",
        )
    return _out(row, await _folder_ids(channel_id), await _skills(channel_id))


class CreateSkillRequest(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    instructions: str = Field(min_length=1, max_length=4000)


@router.post("/{channel_id}/skills", status_code=201)
async def create_skill(
    channel_id: int, body: CreateSkillRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-28: スキル追加（F-12）。「依頼を受けたらこう進める」手順をtitle＋instructionsで登録する。
    services/ai_agent.pyがシステムプロンプトの「# あなたのスキル」節で列挙する"""
    await _get_or_create(channel_id)
    pool = get_pool()
    title = body.title.strip()
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            """INSERT INTO channel_skills (channel_id, title, instructions) VALUES ($1, $2, $3)
               RETURNING id, title, instructions""",
            channel_id, title, body.instructions.strip(),
        )
        await audit_log.record(
            conn, "channel_ai_setting_change", user.id, f"スキル「{title}」を追加しました",
            target_channel_id=channel_id, target_field="skill",
        )
    return {"id": str(row["id"]), "title": row["title"], "instructions": row["instructions"]}


class UpdateSkillRequest(BaseModel):
    title: str = Field(min_length=1, max_length=100)
    instructions: str = Field(min_length=1, max_length=4000)


@router.put("/{channel_id}/skills/{skill_id}")
async def update_skill(
    channel_id: int, skill_id: int, body: UpdateSkillRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-29: スキル更新"""
    pool = get_pool()
    title = body.title.strip()
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            """UPDATE channel_skills SET title = $3, instructions = $4, updated_at = now()
               WHERE id = $1 AND channel_id = $2 RETURNING id, title, instructions""",
            skill_id, channel_id, title, body.instructions.strip(),
        )
        if row is None:
            raise HTTPException(404, detail="スキルが見つかりません")
        await audit_log.record(
            conn, "channel_ai_setting_change", user.id, f"スキル「{title}」を更新しました",
            target_channel_id=channel_id, target_field="skill",
        )
    return {"id": str(row["id"]), "title": row["title"], "instructions": row["instructions"]}


@router.delete("/{channel_id}/skills/{skill_id}", status_code=204)
async def delete_skill(channel_id: int, skill_id: int, user: CurrentUser = Depends(require_channel_admin)):
    """A-30: スキル削除"""
    pool = get_pool()
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            "DELETE FROM channel_skills WHERE id = $1 AND channel_id = $2 RETURNING title", skill_id, channel_id
        )
        if row is None:
            raise HTTPException(404, detail="スキルが見つかりません")
        await audit_log.record(
            conn, "channel_ai_setting_change", user.id, f"スキル「{row['title']}」を削除しました",
            target_channel_id=channel_id, target_field="skill",
        )


class UpdateHandoffRequest(BaseModel):
    fallback_handoff_user_id: str | None = None


@router.put("/{channel_id}/ai-settings/handoff")
async def update_handoff(
    channel_id: int, body: UpdateHandoffRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-45: スキルにない業務依頼の引き継ぎ先（F-17）。未指定（null）で既定のチャンネル管理者へ戻す。
    指定する場合は当該チャンネルの参加者であることをAPI側で検証する（基本設計書8.3節の設計判断）。
    指定した人物が退出・無効化された場合はNULLへ自動的に戻る（channels.py leave_channel/
    remove_channel_member、admin.py update_userを参照）"""
    await _get_or_create(channel_id)
    pool = get_pool()
    target_id: int | None = None
    if body.fallback_handoff_user_id is not None:
        if not body.fallback_handoff_user_id.isdigit():
            raise HTTPException(422, detail="fallback_handoff_user_idは数値のIDです")
        target_id = int(body.fallback_handoff_user_id)
        is_member = await pool.fetchval(
            "SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)",
            channel_id, target_id,
        )
        if not is_member:
            raise HTTPException(400, detail="引き継ぎ先はこのチャンネルの参加者である必要があります")
    row = await pool.fetchrow(
        """UPDATE channel_ai_settings SET fallback_handoff_user_id = $2, updated_by = $3, updated_at = now()
           WHERE channel_id = $1 RETURNING *""",
        channel_id, target_id, user.id,
    )
    await audit_log.record(
        pool, "channel_ai_setting_change", user.id, "スキルの引き継ぎ先を更新しました",
        target_channel_id=channel_id, target_field="fallback_handoff_user_id",
    )
    return _out(row, await _folder_ids(channel_id), await _skills(channel_id))
