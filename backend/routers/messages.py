# A-12〜A-14（詳細設計書 API設計4.3節、基本設計書8.2節 S-04スレッド表示）
# スレッドはチャンネル・DMどちらの発言にもぶら下がれる（T-05.thread_parent_idは自己参照FKで
# channel_id/dm_idを問わない）ため、権限判定は元発言のchannel_id/dm_idに応じて分岐する
# （require_thread_access）。返信自体はネストしない（返信への返信は対象外）。
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from attachments import AttachmentInput, fetch_attachments_grouped, insert_attachments
from auth_helpers import CurrentUser, require_auth, require_thread_access
from database import get_pool
from mentions import MentionInput, fetch_blocks_grouped, insert_mention_blocks
from reactions import fetch_reactions_grouped, toggle_reaction
from services import ai_agent

router = APIRouter(prefix="/api/messages", tags=["messages"])


def _message_out(
    row, blocks: list[dict] | None = None, attachments: list[dict] | None = None,
    reactions: list[dict] | None = None,
) -> dict:
    return {
        "id": str(row["id"]),
        "channel_id": str(row["channel_id"]) if row["channel_id"] is not None else None,
        "dm_id": str(row["dm_id"]) if row["dm_id"] is not None else None,
        "thread_parent_id": str(row["thread_parent_id"]) if row["thread_parent_id"] is not None else None,
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
        # F-14 やりとりの要約で生成された発言かどうか（ユーザーからの要望、フロントが専用バッジを出す）。
        # スレッド全体の要約はここ（A-13/A-14）を通る唯一の経路
        "is_summary": row["is_summary"],
        # 発言の編集（ユーザーからの明示的な要望）。他2ルーターと同じ分岐に揃えておく
        "is_edited": row["edited_at"] is not None,
        "blocks": blocks or [],
        "attachments": attachments or [],
        # 絵文字リアクション（ユーザーからの明示的な要望）。channels.py/dms.pyの_message_outと
        # 同じ形（emoji・count・reacted_by_me・user_names）
        "reactions": reactions or [],
        "created_at": row["created_at"].isoformat(),
        # channels.py/dms.pyの_message_outと型を揃えるため（useThreadは全件再取得のみで
        # sinceカーソルには使わないが、Message型のフィールドとしては必須にしている）
        "updated_at": row["updated_at"].isoformat(),
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


class EditMessageRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


@router.put("/{message_id}")
async def edit_message(message_id: int, body: EditMessageRequest, user: CurrentUser = Depends(require_auth)):
    """発言の編集（ユーザーからの明示的な要望「自分が送ったメッセージに限っては、メッセージを
    送った後でも編集できる機能が欲しい。編集したメッセージには（編集済み）と明記してほしい」）。
    要件定義書上のF-xxに対応付けられた機能ではない新規追加。**A-12削除と異なり投稿者本人限定
    （adminバイパスは無い）**——削除は「消す」だけだが編集は「本文を書き換える」ため、本人以外に
    許可すると本人が言っていない内容を第三者が作文できてしまう。システム通知（F-43）・AI/BOT発言は
    sender_user_idを持たないため自然に対象外になる（本人チェックで弾かれる）。本文以外
    （@メンションの構造化message_blocks・添付ファイル）は編集の対象外とした——本文の再解析は
    通知の再送信・AIの再起動等の副作用に発展しうるため、今回は単純な誤字修正用途を想定し
    本文の書き換えのみに絞った（編集後の本文に新しく「@氏名」等を書いてもクリック可能な
    メンションとしては扱われず、リンク化・太字等の装飾記法のみそのまま解釈される）。"""
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT channel_id, dm_id, sender_user_id FROM messages WHERE id = $1 AND deleted_at IS NULL",
        message_id,
    )
    if row is None:
        raise HTTPException(404, detail="見つかりません")

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
    if not is_member and row["sender_user_id"] != user.id:
        # 参加していない会話にある他人の発言は存在自体を伏せる（A-12等と同じ考え方）。投稿後に
        # 退出した本人（is_member=false・本人）は編集自体は許可する（次の分岐を素通りする）
        raise HTTPException(404, detail="見つかりません")
    if row["sender_user_id"] != user.id:
        raise HTTPException(403, detail="権限がありません")

    updated = await pool.fetchrow(
        "UPDATE messages SET body = $2, edited_at = now(), updated_at = now() WHERE id = $1 RETURNING *",
        message_id, body.body,
    )
    blocks_by_message = await fetch_blocks_grouped(pool, [message_id])
    attachments_by_message = await fetch_attachments_grouped(pool, [message_id])
    reactions_by_message = await fetch_reactions_grouped(pool, [message_id], user.id)
    return _message_out(
        {**dict(updated), "sender_name": user.name, "sender_picture_url": user.picture_url},
        blocks_by_message.get(message_id), attachments_by_message.get(message_id),
        reactions_by_message.get(message_id),
    )


@router.post("/{message_id}/cancel-generation")
async def cancel_generation(message_id: int, user: CurrentUser = Depends(require_auth)):
    """A-74: 生成中のAI発言を強制的に中断する（ユーザーからの明示的な要望）。バックエンドプロセスの
    再起動と生成中のタイミングが重なると、それまで進行中の生成タスク自体が失われる一方でDB側の
    generation_status='generating'だけが残り、実際にKogack運用中「生成中」のまま数十分固まり
    続ける発言が発生した。この復旧手段として追加した。A-12削除と異なり投稿者本人・admin限定にはせず、
    そのチャンネルの参加者であれば誰でも中断できる（AI発言に「所有者」という概念が無く、生成が
    詰まっている状態は参加者全員の閲覧を妨げるため）。DM上のAI発言は存在しない前提だが、
    念のためA-12と同じ参加者チェックの分岐を用意する。"""
    pool = get_pool()
    row = await pool.fetchrow(
        """SELECT channel_id, dm_id, sender_type, generation_status
           FROM messages WHERE id = $1 AND deleted_at IS NULL""",
        message_id,
    )
    if row is None:
        raise HTTPException(404, detail="見つかりません")
    if row["sender_type"] != "ai":
        raise HTTPException(400, detail="AIの発言ではありません")

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
            # 参加していない会話の発言は存在自体を伏せる（A-12・総論5.3節と同じ考え方）
            raise HTTPException(404, detail="見つかりません")

    if row["generation_status"] != "generating":
        raise HTTPException(400, detail="生成中の発言ではありません")

    cancelled = await ai_agent.cancel_generation(message_id)
    if not cancelled:
        # 直前のSELECTと実際の更新の間に自然完了していた等の競合（基本的に発生しても実害は無い）
        raise HTTPException(400, detail="生成中の発言ではありません")

    updated = await pool.fetchrow("SELECT * FROM messages WHERE id = $1", message_id)
    blocks_by_message = await fetch_blocks_grouped(pool, [message_id])
    attachments_by_message = await fetch_attachments_grouped(pool, [message_id])
    reactions_by_message = await fetch_reactions_grouped(pool, [message_id], user.id)
    return _message_out(
        updated, blocks_by_message.get(message_id), attachments_by_message.get(message_id),
        reactions_by_message.get(message_id),
    )


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
    attachments_by_message = await fetch_attachments_grouped(pool, [r["id"] for r in rows])
    reactions_by_message = await fetch_reactions_grouped(pool, [r["id"] for r in rows], user.id)
    return {
        "items": [
            _message_out(
                r, blocks_by_message.get(r["id"]), attachments_by_message.get(r["id"]),
                reactions_by_message.get(r["id"]),
            )
            for r in rows
        ]
    }


class PostReplyRequest(BaseModel):
    body: str = Field(min_length=1, max_length=4000)
    mentions: list[MentionInput] = []
    attachments: list[AttachmentInput] = []


@router.post("/{message_id}/thread", status_code=201)
async def post_reply(
    message_id: int, body: PostReplyRequest, user: CurrentUser = Depends(require_thread_access),
):
    """A-14: スレッドへの返信投稿。channel_id/dm_idは元発言から引き継ぐ。@メンション（F-41）は
    元発言がチャンネル・DMいずれの場合もT-07へ保存する（バグ修正2026-09-04でDMも対応。ユーザーからの
    明示的な要望「DMでもメンションできるようにしたい」）。添付ファイル（F-07）はチャンネル・DM
    どちらの返信でも対象（メンションと異なり候補元に依存しないため元々対応済み）。チャンネルAIへの
    メンション（本文中の「@ペルソナ名」）を検知した場合、A-11と同様にservices/ai_agent.pyの応答生成を
    非同期タスクとして起動する（元発言がチャンネルの場合のみ。DMにはチャンネルAI自体が存在しないため
    引き続き対象外。応答は同じスレッドへの返信として投稿される）"""
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
        blocks = await insert_mention_blocks(
            conn, row["id"], body.mentions, channel_id=parent["channel_id"], dm_id=parent["dm_id"],
            sender_user_id=user.id,
        )
        attachments = await insert_attachments(conn, row["id"], user.id, body.attachments)
    if parent["channel_id"] is not None:
        await ai_agent.maybe_trigger(parent["channel_id"], body.body, user.id, thread_id=message_id)
    return _message_out(
        {**dict(row), "sender_name": user.name, "sender_picture_url": user.picture_url}, blocks, attachments,
    )


class ToggleReactionRequest(BaseModel):
    emoji: str = Field(min_length=1, max_length=32)


@router.post("/{message_id}/reactions/toggle")
async def toggle_message_reaction(
    message_id: int, body: ToggleReactionRequest, user: CurrentUser = Depends(require_auth),
):
    """A-75: 発言への絵文字リアクションをトグルする（ユーザーからの明示的な要望「Slackのように
    発言一つ一つに対して絵文字でリアクションできるようにしたい」）。既に自分が同じ絵文字で
    リアクション済みなら取り消し、していなければ追加する（T-26、reactions.toggle_reaction）。
    権限はA-12削除・A-74中断と同じ「その会話の参加者であること」だが、投稿者本人限定にはしない
    （誰の発言にも誰でもリアクションできるのがSlack等の一般的な挙動のため）。システム通知（F-43）
    へのリアクションも特別扱いしない——返信・削除は「参加・退出の記録の信頼性」を保つため対象外に
    しているが、リアクションはその記録自体を書き換えるものではなく対象外にする理由が無いと判断した。"""
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT channel_id, dm_id FROM messages WHERE id = $1 AND deleted_at IS NULL", message_id,
    )
    if row is None:
        raise HTTPException(404, detail="見つかりません")

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
            # 参加していない会話の発言は存在自体を伏せる（A-12・A-74・総論5.3節と同じ考え方）
            raise HTTPException(404, detail="見つかりません")

    added = await toggle_reaction(pool, message_id, user.id, body.emoji)
    reactions_by_message = await fetch_reactions_grouped(pool, [message_id], user.id)
    return {"id": str(message_id), "added": added, "reactions": reactions_by_message.get(message_id, [])}
