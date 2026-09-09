# A-23〜A-31, A-45（詳細設計書 API設計4.6節、基本設計書8.3節）。S-06 AI設定タブのうち「基本設定」
# 「キャラクタ」「振る舞い定義」「参照ドキュメント範囲」「スキル」「反応モード」「自動対応範囲」の
# 7タブに対応する。
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import audit_log
from auth_helpers import CurrentUser, require_channel_admin
from database import get_pool
from services import doc_permissions

router = APIRouter(prefix="/api/channels", tags=["ai-settings"])


def _out(row, folder_ids: list[str], skills: list[dict], auto_response_rules: list[dict]) -> dict:
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
        "auto_response_rules": auto_response_rules,
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


async def _auto_response_rules(channel_id: int) -> list[dict]:
    rows = await get_pool().fetch(
        """SELECT request_category, response_level FROM channel_auto_response_rules
           WHERE channel_id = $1 ORDER BY created_at""",
        channel_id,
    )
    return [{"request_category": r["request_category"], "response_level": r["response_level"]} for r in rows]


@router.get("/{channel_id}/ai-settings")
async def get_ai_settings(channel_id: int, user: CurrentUser = Depends(require_channel_admin)):
    """A-23: AI設定一括取得（S-06）"""
    settings = await _get_or_create(channel_id)
    return _out(settings, await _folder_ids(channel_id), await _skills(channel_id), await _auto_response_rules(channel_id))


class UpdateGeneralRequest(BaseModel):
    is_ai_enabled: bool
    reaction_mode: str


@router.put("/{channel_id}/ai-settings/general")
async def update_general(
    channel_id: int, body: UpdateGeneralRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-24: AI有効/無効の切り替え・反応モード（F-15）の変更。基本設定タブ（GeneralTab）と
    反応モードタブ（ReactionTab）はいずれもこのAPIを呼ぶが、A-27参照ドキュメント範囲と同じく
    自分が変更しない側のフィールドも現在値のまま一緒に送る（差分計算はしない）"""
    if body.reaction_mode not in ("mention_only", "proactive"):
        raise HTTPException(422, detail="reaction_modeはmention_only/proactiveのいずれかです")
    await _get_or_create(channel_id)
    pool = get_pool()
    row = await pool.fetchrow(
        """UPDATE channel_ai_settings SET is_ai_enabled = $2, reaction_mode = $3,
               updated_by = $4, updated_at = now()
           WHERE channel_id = $1 RETURNING *""",
        channel_id, body.is_ai_enabled, body.reaction_mode, user.id,
    )
    mode_label = "メンション時のみ応答" if body.reaction_mode == "mention_only" else "投稿に自ら反応"
    await audit_log.record(
        pool, "channel_ai_setting_change", user.id,
        f"AIを{'有効' if body.is_ai_enabled else '無効'}にし、反応モードを「{mode_label}」にしました",
        target_channel_id=channel_id, target_field="general",
    )
    return _out(row, await _folder_ids(channel_id), await _skills(channel_id), await _auto_response_rules(channel_id))


class UpdateCharacterRequest(BaseModel):
    persona_name: str = Field(min_length=1, max_length=50)
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
    return _out(row, await _folder_ids(channel_id), await _skills(channel_id), await _auto_response_rules(channel_id))


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
    return _out(row, await _folder_ids(channel_id), await _skills(channel_id), await _auto_response_rules(channel_id))


class UpdateDocScopeRequest(BaseModel):
    folder_ids: list[str] = Field(default_factory=list)
    out_of_scope_policy: str = "strict"
    # falseのまま409（要確認）を受け取った後、確認ダイアログで「はい」を押した場合のみtrueにして
    # 再送信する（閲覧権限モデルSlice 2b、(5)）。この場合のみ権限を失う参加者を強制退出させる。
    force: bool = False


@router.put("/{channel_id}/ai-settings/doc-scope")
async def update_doc_scope(
    channel_id: int, body: UpdateDocScopeRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-27: 参照ドキュメント範囲（F-11・F-22）。folder_idsは送信された集合でT-10を洗い替える。
    S-08で削除済み・存在しないfolder_idは黙って無視する（F-41のメンション対象外指定と同じ考え方で、
    設定保存自体を失敗させない）。実際のDrive同期・索引・AI検索（search_documentsツール）は
    次スライスで実装するため、この設定は現時点ではAI応答に反映されない（CLAUDE.md実装状況節）。

    閲覧権限モデル（Slice 2b、2026-09-09、(4)(5)(6)）: 限定公開フォルダ（is_restricted）は
    公開チャンネルの参照範囲には一切追加できない（ハードブロック、確認では回避できない）。
    非公開チャンネルには追加できるが、新たに追加しようとするフォルダについて参加者全員が
    閲覧権限を持っている必要がある。権限の無い参加者がいる場合、force=falseなら409で
    対象者を返し（確認ダイアログの材料）、force=trueならその対象者を強制退出させたうえで
    追加する。ただし対象に最後のチャンネル管理者が含まれる場合はforce=trueでも400で拒否する
    （既存のA-48/A-72/A-73と同じ安全策）。この判定は「新たに追加しようとしているフォルダ」
    （現在の設定に既に含まれているフォルダは対象外）のみ行う——既存の割当分は、招待時の
    チェック（A-08、services/doc_permissions.py）により参加者全員の権限が既に保たれている
    はずという不変条件を前提にしている。"""
    if body.out_of_scope_policy not in ("strict", "general"):
        raise HTTPException(422, detail="out_of_scope_policyはstrict/generalのいずれかです")
    try:
        requested_ids = {int(x) for x in body.folder_ids}
    except ValueError:
        raise HTTPException(422, detail="folder_idsは数値のIDです")

    await _get_or_create(channel_id)
    pool = get_pool()
    async with pool.acquire() as conn, conn.transaction():
        channel = await conn.fetchrow("SELECT is_public FROM channels WHERE id = $1", channel_id)
        if channel is None:
            raise HTTPException(404, detail="見つかりません")
        folders = await conn.fetch(
            "SELECT id, is_restricted, drive_folder_name FROM doc_folders WHERE id = ANY($1::bigint[])",
            list(requested_ids),
        )
        valid_ids = {r["id"] for r in folders}

        if channel["is_public"]:
            restricted_requested = [r for r in folders if r["is_restricted"]]
            if restricted_requested:
                names = "、".join(r["drive_folder_name"] for r in restricted_requested)
                raise HTTPException(
                    422, detail=f"公開チャンネルには限定公開のフォルダを含められません: {names}"
                )
        else:
            current_ids = {int(x) for x in await _folder_ids(channel_id)}
            newly_added = valid_ids - current_ids
            affected: list[dict] = []
            for r in folders:
                if r["id"] not in newly_added or not r["is_restricted"]:
                    continue
                missing = await doc_permissions.members_missing_access(conn, channel_id, r["id"])
                if missing:
                    affected.append({"folder_id": str(r["id"]), "folder_name": r["drive_folder_name"], "members": missing})
            if affected and not body.force:
                raise HTTPException(409, detail={"message": "権限のない参加者がいます", "affected": affected})
            if affected and body.force:
                target_user_ids = {int(m["id"]) for a in affected for m in a["members"]}
                removals = [(channel_id, uid) for uid in target_user_ids]
                conflicts = await doc_permissions.check_last_admin_conflicts(conn, removals)
                if conflicts:
                    raise HTTPException(
                        400,
                        detail={
                            "message": "最後のチャンネル管理者を退出させる操作は実行できません",
                            "conflicts": conflicts,
                        },
                    )
                for _, uid in removals:
                    await doc_permissions.force_remove_member(conn, channel_id, uid)

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
    return _out(row, await _folder_ids(channel_id), await _skills(channel_id), await _auto_response_rules(channel_id))


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
    return _out(row, await _folder_ids(channel_id), await _skills(channel_id), await _auto_response_rules(channel_id))


class AutoResponseRuleInput(BaseModel):
    request_category: str = Field(min_length=1, max_length=100)
    response_level: str


class UpdateAutoResponseRequest(BaseModel):
    rules: list[AutoResponseRuleInput] = Field(default_factory=list)


@router.put("/{channel_id}/ai-settings/auto-response")
async def update_auto_response(
    channel_id: int, body: UpdateAutoResponseRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-31: 自動対応範囲（F-16）。送信されたルール集合でT-12を洗い替える（A-27参照ドキュメント範囲と
    同じ「差分計算をしないDELETE→INSERT」パターン）。request_categoryはチャンネル管理者が自由に
    追加・削除できる（REQ-F-15「担当部署が自ら決められる」を優先。画面モックアップの6例は固定候補では
    なく記入例。基本設計書6.2節に設計判断を追記）。同じrequest_categoryが複数送られた場合は最後の
    指定を採用する（Pythonのdictでキー重複を解決し、DBのUNIQUE制約違反を避ける）"""
    for r in body.rules:
        if r.response_level not in ("auto", "confirm", "human"):
            raise HTTPException(422, detail="response_levelはauto/confirm/humanのいずれかです")
    deduped = {r.request_category.strip(): r.response_level for r in body.rules if r.request_category.strip()}

    await _get_or_create(channel_id)
    pool = get_pool()
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("DELETE FROM channel_auto_response_rules WHERE channel_id = $1", channel_id)
        if deduped:
            await conn.executemany(
                """INSERT INTO channel_auto_response_rules (channel_id, request_category, response_level)
                   VALUES ($1, $2, $3)""",
                [(channel_id, category, level) for category, level in deduped.items()],
            )
        row = await conn.fetchrow("SELECT * FROM channel_ai_settings WHERE channel_id = $1", channel_id)
        await audit_log.record(
            conn, "channel_ai_setting_change", user.id, "自動対応範囲を更新しました",
            target_channel_id=channel_id, target_field="auto_response",
        )
    return _out(row, await _folder_ids(channel_id), await _skills(channel_id), await _auto_response_rules(channel_id))
