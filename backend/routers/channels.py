# A-05〜A-08, A-10〜A-11, A-46〜A-49（詳細設計書 API設計4.3節・4.6節、総論5.1節・5.3節）
# 添付ファイル（F-07）のアップロード/ダウンロード自体はrouters/attachments.py（A-21/A-22）に分離し、
# このルーターはA-11投稿時に確定したmessage_idへの紐づけのみをattachments.pyの共通処理経由で行う。
# 送信予約はrouters/scheduled_messages.py、チャンネルAI設定はrouters/ai_settings.py、定期投稿は
# routers/recurring_posts.py、自動応答トリガーはrouters/trigger_rules.pyに分離。
# S-06チャンネル設定は「チャンネル管理者」「基本設定」「キャラクタ」「振る舞い定義」「定期投稿」
# 「自動応答トリガー」の6タブを実装し、「参照ドキュメント範囲」「スキル」「反応モード」「自動対応範囲」の
# 4タブは対応する基盤（ドキュメント索引・自動対応分類）が未実装のため対象外（CLAUDE.md 実装状況節）。
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from attachments import AttachmentInput, fetch_attachments_grouped, insert_attachments
from auth_helpers import (
    CurrentUser, require_auth, require_channel_admin, require_channel_member, require_channel_member_or_admin,
)
from database import get_pool
from mentions import MentionInput, fetch_blocks_grouped, insert_mention_blocks
from services import ai_agent, trigger_matcher

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
        # T-08 channel_ai_settingsを既定値で作成しておく（基本設計書8章）。この機能より前に
        # 作成された既存チャンネルには行が無いため、そちらはA-23初回アクセス時に補完する
        # （routers/ai_settings.py _get_or_create）
        await conn.execute("INSERT INTO channel_ai_settings (channel_id) VALUES ($1)", row["id"])
    return _channel_out(row)


@router.get("/{channel_id}")
async def get_channel(channel_id: int, user: CurrentUser = Depends(require_channel_member_or_admin)):
    """A-06: チャンネル詳細。システムadminは非参加の非公開チャンネルでもメタデータのみ取得できる
    （S-06チャンネル設定を開くために必要。auth_helpers.require_channel_member_or_adminを参照）。
    非参加adminにも200が返るようになったため、レスポンスに`is_member`（呼び出し元が実際の参加者か）
    を追加した。フロント（ChannelView.tsx）はこれを見て、非参加adminがS-03（会話画面。発言本文は
    A-10が引き続き参加者限定でブロックする）を誤って開いたままにならないよう、S-06以外では
    従来どおりワークスペースへリダイレクトする"""
    pool = get_pool()
    row = await pool.fetchrow("SELECT * FROM channels WHERE id = $1", channel_id)
    member_count = await pool.fetchval(
        "SELECT count(*) FROM channel_members WHERE channel_id = $1", channel_id
    )
    is_admin = await pool.fetchval(
        "SELECT is_channel_admin FROM channel_members WHERE channel_id = $1 AND user_id = $2",
        channel_id, user.id,
    )
    is_member = await pool.fetchval(
        "SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)",
        channel_id, user.id,
    )
    # AIメンションのハイライト表示用（F-41同様の見た目にする、フロント側の要望）。A-23と異なり
    # 参加者全員がA-06を呼べるため、ここでpersona_nameだけ軽量に返す
    # （services/ai_agent.detect_mentionと同じ「@ペルソナ名」文字列一致をフロントでも再現するために必要）
    ai_persona_name = await pool.fetchval(
        "SELECT persona_name FROM channel_ai_settings WHERE channel_id = $1", channel_id
    )
    return {
        **_channel_out(row), "member_count": member_count,
        "is_channel_admin": bool(is_admin), "is_member": bool(is_member),
        "ai_persona_name": ai_persona_name or "AI",
    }


class UpdateChannelRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=256)
    topic: str | None = None


@router.put("/{channel_id}")
async def update_channel(
    channel_id: int, body: UpdateChannelRequest, user: CurrentUser = Depends(require_channel_admin),
):
    """A-71: チャンネル名・説明（トピック）の編集。name/topicいずれも省略可（指定したフィールドのみ
    更新する）。nameは全チャンネルで一意（A-07作成時と同じ制約）。当該chadmin/adminのみ実行できる。
    設計書に無い挙動のため基本設計書・詳細設計書API設計・画面モックアップをあわせて改訂した"""
    pool = get_pool()
    if body.name is not None:
        duplicate = await pool.fetchval(
            "SELECT EXISTS(SELECT 1 FROM channels WHERE name = $1 AND id != $2)", body.name, channel_id
        )
        if duplicate:
            raise HTTPException(409, detail="既に使用されています")
        await pool.execute(
            "UPDATE channels SET name = $2, updated_at = now() WHERE id = $1", channel_id, body.name
        )
    if body.topic is not None:
        # 空文字は説明文を削除する操作として扱いNULLにする
        await pool.execute(
            "UPDATE channels SET topic = $2, updated_at = now() WHERE id = $1",
            channel_id, body.topic.strip() or None,
        )
    row = await pool.fetchrow("SELECT * FROM channels WHERE id = $1", channel_id)
    return _channel_out(row)


@router.delete("/{channel_id}", status_code=204)
async def delete_channel(channel_id: int, user: CurrentUser = Depends(require_channel_admin)):
    """A-09: チャンネル削除（設計書には以前からAPI一覧のみ記載で未実装だった。今回backfill）。
    参加者・発言・メッセージブロック・送信予約・AI設定・利用ログ・既読状態はいずれも
    channels(id)へのON DELETE CASCADEで連動削除される（database.py参照）。取り消せない操作の
    ため、フロント側は削除対象のチャンネル名の再入力を経てから呼び出す（ChannelSettings.tsx）"""
    await get_pool().execute("DELETE FROM channels WHERE id = $1", channel_id)


class JoinChannelRequest(BaseModel):
    user_id: str | None = None


@router.post("/{channel_id}/members", status_code=201)
async def join_channel(
    channel_id: int, body: JoinChannelRequest | None = None, user: CurrentUser = Depends(require_auth),
):
    """A-08: 参加・招待（F-34）。公開チャンネルは、本人が自分で検索して参加する経路（本文省略、
    または自分自身のuser_id指定）と、既存の参加者が他の利用者をuser_id指定で追加する経路の
    両方に対応する。非公開チャンネルは既存の参加者が他の利用者をuser_id指定で追加する経路のみ
    （本人による自己参加は不可）。招待はいずれもchadmin限定にせず参加者全員に開放
    （基本設計書6.2節「設計判断」）。"""
    pool = get_pool()
    channel = await pool.fetchrow("SELECT is_public FROM channels WHERE id = $1", channel_id)
    if channel is None:
        raise HTTPException(404, detail="見つかりません")
    target_user_id = body.user_id if body else None

    if channel["is_public"]:
        if target_user_id is None or target_user_id == str(user.id):
            target_id = user.id
        else:
            # 他の利用者を公開チャンネルへ追加する場合は、呼び出し元が既に参加者である必要がある
            # （非公開チャンネルの招待と同じ考え方。誰でも自己参加できる公開チャンネルでも、
            # 第三者を勝手に追加できてしまうのは望ましくないため）
            is_member = await pool.fetchval(
                "SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)",
                channel_id, user.id,
            )
            if not is_member:
                raise HTTPException(403, detail="他の利用者を追加するには、先に自分がこのチャンネルに参加している必要があります")
            try:
                target_id = int(target_user_id)
            except ValueError:
                raise HTTPException(422, detail="不正なuser_idです")
            target_exists = await pool.fetchval(
                "SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND is_active)", target_id
            )
            if not target_exists:
                raise HTTPException(404, detail="見つかりません")
    else:
        is_member = await pool.fetchval(
            "SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)",
            channel_id, user.id,
        )
        if not is_member:
            # 非公開チャンネルの非参加者には存在を伏せる（総論5.3節と同じ考え方）
            raise HTTPException(404, detail="見つかりません")
        if target_user_id is None:
            raise HTTPException(403, detail="非公開チャンネルへの参加には招待が必要です")
        try:
            target_id = int(target_user_id)
        except ValueError:
            raise HTTPException(422, detail="不正なuser_idです")
        target_exists = await pool.fetchval(
            "SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND is_active)", target_id
        )
        if not target_exists:
            raise HTTPException(404, detail="見つかりません")

    already = await pool.fetchval(
        "SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)",
        channel_id, target_id,
    )
    if already:
        raise HTTPException(409, detail="既に参加しています")

    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            """INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)
               RETURNING channel_id, user_id, is_channel_admin, joined_at""",
            channel_id, target_id,
        )
        target_name = user.name if target_id == user.id else await conn.fetchval(
            "SELECT name FROM users WHERE id = $1", target_id
        )
        # F-43: 入室通知。F-36/F-38と同じsender_type='bot'を流用し、新規テーブル・列は追加しない
        # （基本設計書6.2節「設計判断」）。表示名は固定で「システム通知」
        await conn.execute(
            """INSERT INTO messages (channel_id, sender_type, bot_display_name, body)
               VALUES ($1, 'bot', 'システム通知', $2)""",
            channel_id, f"{target_name} さんが参加しました。",
        )
    return {
        "channel_id": str(row["channel_id"]), "user_id": str(row["user_id"]),
        "is_channel_admin": row["is_channel_admin"], "joined_at": row["joined_at"].isoformat(),
    }


@router.delete("/{channel_id}/members/me", status_code=204)
async def leave_channel(channel_id: int, user: CurrentUser = Depends(require_channel_member)):
    """A-72: チャンネルからの退出。管理者不在を防ぐため、自分が最後のチャンネル管理者の場合は拒否する
    （A-48「最後の管理者は解除できません」と同じ考え方。最後の1人は必ずchadminであるため、
    このチェックだけでチャンネルが参加者ゼロになる事態も同時に防げる）。F-43の入室通知と対になる
    退出通知をT-05へ作成する（同じsender_type='bot'の枠組みを流用）。F-17の引き継ぎ先
    （channel_ai_settings.fallback_handoff_user_id）に自分が指定されていた場合はNULLへ戻す
    （基本設計書8.3節「指定した人物が退出・無効化された場合は既定のchadminへ引き継ぎに戻す」）"""
    pool = get_pool()
    is_admin = await pool.fetchval(
        "SELECT is_channel_admin FROM channel_members WHERE channel_id = $1 AND user_id = $2",
        channel_id, user.id,
    )
    if is_admin:
        admin_count = await pool.fetchval(
            "SELECT count(*) FROM channel_members WHERE channel_id = $1 AND is_channel_admin", channel_id
        )
        if admin_count <= 1:
            raise HTTPException(
                400, detail="最後のチャンネル管理者は退出できません。先に他の参加者をチャンネル管理者にしてください"
            )
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(
            "DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2", channel_id, user.id
        )
        await conn.execute(
            """UPDATE channel_ai_settings SET fallback_handoff_user_id = NULL
               WHERE channel_id = $1 AND fallback_handoff_user_id = $2""",
            channel_id, user.id,
        )
        await conn.execute(
            """INSERT INTO messages (channel_id, sender_type, bot_display_name, body)
               VALUES ($1, 'bot', 'システム通知', $2)""",
            channel_id, f"{user.name} さんが退出しました。",
        )


@router.delete("/{channel_id}/members/{target_user_id}", status_code=204)
async def remove_channel_member(
    channel_id: int, target_user_id: int, user: CurrentUser = Depends(require_channel_admin),
):
    """A-73: メンバーをチャンネルから退出させる。当該chadmin/adminのみ実行できる。対象が最後の
    チャンネル管理者の場合はA-48/A-72と同じ理由で400拒否する（chadmin同士でも実行できる）。
    この経路より前に`/{channel_id}/members/me`（A-72）を定義しておく必要がある。FastAPIは
    パスの文字列としては"me"も{target_user_id}にマッチしうるため、後で定義するとA-72に
    「me」という文字列でリクエストが来てもこちらが先に一致し、int変換に失敗して422になってしまう。
    A-72と同じ退出通知をT-05へ作成する（誰が退出させたかは本文に含めない。F-43の入室通知が
    招待者を明記しないのと同じ考え方）。A-72と同じくF-17の引き継ぎ先がこの対象者だった場合はNULLへ戻す"""
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
            raise HTTPException(
                400, detail="最後のチャンネル管理者は退出させられません。先に他の参加者をチャンネル管理者にしてください"
            )
    async with pool.acquire() as conn, conn.transaction():
        target_name = await conn.fetchval("SELECT name FROM users WHERE id = $1", target_user_id)
        await conn.execute(
            "DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2", channel_id, target_user_id
        )
        await conn.execute(
            """UPDATE channel_ai_settings SET fallback_handoff_user_id = NULL
               WHERE channel_id = $1 AND fallback_handoff_user_id = $2""",
            channel_id, target_user_id,
        )
        await conn.execute(
            """INSERT INTO messages (channel_id, sender_type, bot_display_name, body)
               VALUES ($1, 'bot', 'システム通知', $2)""",
            channel_id, f"{target_name} さんが退出しました。",
        )


@router.get("/{channel_id}/members")
async def list_channel_members(channel_id: int, user: CurrentUser = Depends(require_channel_member_or_admin)):
    """A-46: 参加者一覧（chadmin/adminバッジ表示・補足03メンバー一覧、S-06チャンネル管理者タブでの
    追加候補選定に使用）。システムadminは非参加の非公開チャンネルでも取得できる（A-06と同じ理由）"""
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT u.id, u.name, u.email, u.picture_url, u.role, u.is_active,
               cm.is_channel_admin, cm.joined_at
           FROM channel_members cm JOIN users u ON u.id = cm.user_id
           WHERE cm.channel_id = $1 ORDER BY u.name""",
        channel_id,
    )
    return {
        "items": [
            {
                "id": str(r["id"]), "name": r["name"], "email": r["email"], "picture_url": r["picture_url"],
                "role": r["role"], "is_active": r["is_active"],
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


def _message_out(row, blocks: list[dict] | None = None, attachments: list[dict] | None = None) -> dict:
    return {
        "id": str(row["id"]),
        "channel_id": str(row["channel_id"]),
        "sender_type": row["sender_type"],
        "sender_user_id": str(row["sender_user_id"]) if row["sender_user_id"] is not None else None,
        # BOT/AI発言（いずれもsender_user_id無し）はbot_display_nameを表示名として使う（F-36/F-38/F-43、
        # AI発言はservices/ai_agent.pyがペルソナ名をこの列にスナップショットする）。この分岐にAI発言が
        # 抜けていたため、これまでAI発言のsender_nameが常にnull（表示は「(不明)」）になっていたバグを修正
        "sender_name": row["bot_display_name"] if row["sender_type"] in ("bot", "ai") else row["sender_name"],
        # AI発言・BOT発言はいずれもbot_icon_urlにアイコンのスナップショットを持つ（services/ai_agent.py、
        # F-36/F-38の送り主アイコン）。BOT発言はsender_user_idが無いためJOIN結果が自然にNULLになる
        "sender_picture_url": row["bot_icon_url"] if row["sender_type"] in ("ai", "bot") else row["sender_picture_url"],
        # F-36/F-38の絵文字アイコン（画像未設定時のフォールバック。F-43システム通知は常にNULLなので
        # フロント側の既定🔔表示のまま）。AI・人間の発言では使わない
        "bot_icon": row["bot_icon"] if row["sender_type"] == "bot" else None,
        "body": row["body"],
        "generation_status": row["generation_status"],
        "thread_reply_count": row["thread_reply_count"],
        "blocks": blocks or [],
        "attachments": attachments or [],
        "created_at": row["created_at"].isoformat(),
    }


_MESSAGES_SELECT = """SELECT m.*, u.name AS sender_name, u.picture_url AS sender_picture_url,
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
    else:
        rows = list(reversed(await pool.fetch(
            f"""{_MESSAGES_SELECT}
               WHERE m.channel_id = $1 AND m.deleted_at IS NULL AND m.thread_parent_id IS NULL
               ORDER BY m.created_at DESC LIMIT $2""",
            channel_id, limit,
        )))
    blocks_by_message = await fetch_blocks_grouped(pool, [r["id"] for r in rows])
    attachments_by_message = await fetch_attachments_grouped(pool, [r["id"] for r in rows])
    items = [
        _message_out(r, blocks_by_message.get(r["id"]), attachments_by_message.get(r["id"])) for r in rows
    ]
    if since:
        return {"items": items, "has_more": False}
    return {"items": items, "has_more": len(rows) == limit}


class PostMessageRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    mentions: list[MentionInput] = []
    attachments: list[AttachmentInput] = []


@router.post("/{channel_id}/messages", status_code=201)
async def post_message(
    channel_id: int, body: PostMessageRequest, user: CurrentUser = Depends(require_channel_member),
):
    """A-11: メッセージ投稿。人間へのメンション（F-41）はT-07へ保存する。添付ファイル（F-07）は
    A-21で保存済みの実体をT-06へ紐づける（attachments.py参照）。チャンネルAIへの
    メンション（本文中の「@ペルソナ名」文字列一致、基本設計書5.22節）を検知した場合は
    services/ai_agent.pyの応答生成を非同期タスクとして起動する（8.1節・8.7節、REQ-N-05。
    このAPI自体はAI応答を待たずに投稿完了を返す）。自動応答トリガー（F-38）は
    services/trigger_matcher.pyが同期的に判定する（基本設計書6.2節「設計判断」。DB1件挿入のみで
    完結しレイテンシを気にする必要がないため、AI応答と異なり投稿完了を待たせても支障がない）"""
    pool = get_pool()
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            """INSERT INTO messages (channel_id, sender_type, sender_user_id, body)
               VALUES ($1, 'human', $2, $3) RETURNING *""",
            channel_id, user.id, body.body,
        )
        blocks = await insert_mention_blocks(conn, row["id"], channel_id, body.mentions)
        attachments = await insert_attachments(conn, row["id"], user.id, body.attachments)
    await trigger_matcher.maybe_trigger(channel_id, body.body)
    await ai_agent.maybe_trigger(channel_id, body.body, user.id)
    return _message_out(
        {**dict(row), "sender_name": user.name, "sender_picture_url": user.picture_url, "thread_reply_count": 0},
        blocks,
        attachments,
    )


class SummarizeRequest(BaseModel):
    thread_id: str | None = None


@router.post("/{channel_id}/summarize", status_code=201)
async def summarize_channel(
    channel_id: int, body: SummarizeRequest, user: CurrentUser = Depends(require_channel_member),
):
    """A-15: 要約実行（F-14）。thread_id指定時はそのスレッド全体、未指定時はチャンネル本体の
    直近100件を対象とする（基本設計書5.6節）。実際の生成はservices/ai_agent.pyが非同期で行い
    （メンション応答と同じgeneration_status='generating'の仮レコード方式、8.7節）、このAPIは
    投稿完了を待たずに返す。AI未設定・チャンネルAI無効の場合は400（maybe_triggerと異なり、
    明示的なボタン操作のため黙って何もしないのではなく理由を返す）。"""
    thread_id: int | None = None
    if body.thread_id is not None:
        if not body.thread_id.isdigit():
            raise HTTPException(422, detail="thread_idは数値のIDです")
        thread_id = int(body.thread_id)
        parent = await get_pool().fetchrow(
            "SELECT channel_id FROM messages WHERE id = $1 AND deleted_at IS NULL", thread_id
        )
        if parent is None or parent["channel_id"] != channel_id:
            raise HTTPException(404, detail="見つかりません")
    try:
        result = await ai_agent.start_summary(channel_id, thread_id, user.id)
    except ai_agent.SummaryUnavailable as e:
        raise HTTPException(400, detail=str(e))
    return {
        "message_id": str(result["message_id"]),
        "thread_id": str(result["thread_id"]) if result["thread_id"] is not None else None,
    }
