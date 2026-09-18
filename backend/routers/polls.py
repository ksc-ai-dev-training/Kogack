# アンケート機能（T-29 polls/poll_options/poll_votes、要件定義書上のF-xxに対応付けられていない
# 新規機能。ユーザーからの明示的な要望「チャットアプリに新しくアンケート機能を付けてほしい」、
# 2026-09-18）。作成はchannels.py・dms.pyの投稿系エンドポイントに委ねる（アンケートは「新規発言
# として投稿する」操作のため、通常の投稿と同じ参加者チェック・投稿経路を再利用できる）。この
# ルーターは投票・締め切りという、poll_idを直接指定する操作のみを扱う（routers/attachments.pyの
# A-22ダウンロードが/api/attachments/{id}というチャンネル/DMをまたぐ独立エンドポイントなのと
# 同じ構成）。
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import polls
from auth_helpers import CurrentUser, require_auth
from database import get_pool

router = APIRouter(prefix="/api/polls", tags=["polls"])


async def _fetch_poll_with_scope(pool, poll_id: int):
    """アンケートの所属するchannel_id/dm_idもあわせて取得する（参加者チェック用）。"""
    return await pool.fetchrow(
        """SELECT p.*, m.channel_id, m.dm_id FROM polls p
           JOIN messages m ON m.id = p.message_id
           WHERE p.id = $1""",
        poll_id,
    )


async def _require_poll_participant(pool, poll_row, user_id: int):
    """そのアンケートが投稿されたチャンネル・DMの参加者であることを要求する。A-12削除等と同じく
    Depends注入のrequire_channel_member/require_dm_memberがpoll_idベースでは使えないため手動で
    再現する。非参加者には存在自体を伏せる（F-34と同じプライバシー設計の踏襲）。"""
    if poll_row["channel_id"] is not None:
        member = await pool.fetchval(
            "SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2",
            poll_row["channel_id"], user_id,
        )
    else:
        member = await pool.fetchval(
            "SELECT 1 FROM direct_message_members WHERE dm_id = $1 AND user_id = $2",
            poll_row["dm_id"], user_id,
        )
    if not member:
        raise HTTPException(404, detail="アンケートが見つかりません")


class VoteRequest(BaseModel):
    option_id: str


@router.post("/{poll_id}/vote")
async def vote(poll_id: int, body: VoteRequest, user: CurrentUser = Depends(require_auth)):
    """投票する（単一選択のみのため、既に投票済みの場合は新しい選択肢へ上書きする＝投票の
    やり直し）。投票できるのはそのアンケートが投稿されたチャンネル・DMの参加者のみ、かつ
    アンケートが締め切られていない場合のみ。message_reactions.toggle_reactionと同じく、
    同じトランザクションでmessages.updated_atも更新し、他の参加者の差分ポーリングで
    この発言（投票結果）の変化が拾われるようにする。更新後のpoll payload（reactions.
    toggle_reactionのレスポンスと同じ考え方）を返し、フロントが次のポーリングを待たず
    その場で結果を反映できるようにする。"""
    pool = get_pool()
    poll_row = await _fetch_poll_with_scope(pool, poll_id)
    if poll_row is None:
        raise HTTPException(404, detail="アンケートが見つかりません")
    await _require_poll_participant(pool, poll_row, user.id)
    if poll_row["closed_at"] is not None:
        raise HTTPException(400, detail="このアンケートは締め切られています")
    try:
        option_id = int(body.option_id)
    except ValueError:
        raise HTTPException(422, detail="不正な選択肢です") from None
    option_exists = await pool.fetchval(
        "SELECT 1 FROM poll_options WHERE id = $1 AND poll_id = $2", option_id, poll_id,
    )
    if not option_exists:
        raise HTTPException(422, detail="不正な選択肢です")
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(
            """INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES ($1, $2, $3)
               ON CONFLICT (poll_id, user_id) DO UPDATE SET option_id = $2, voted_at = now()""",
            poll_id, option_id, user.id,
        )
        await conn.execute("UPDATE messages SET updated_at = now() WHERE id = $1", poll_row["message_id"])
        result = await polls.fetch_polls_grouped(conn, [poll_row["message_id"]], user.id)
    return result[poll_row["message_id"]]


@router.post("/{poll_id}/close")
async def close_poll(poll_id: int, user: CurrentUser = Depends(require_auth)):
    """アンケートを締め切る（作成者本人、またはシステム管理者のみ。A-12メッセージ削除・
    カスタム絵文字削除と同じ権限パターン）。締め切り後は投票を受け付けなくなるが、結果は
    そのまま会話ログに残り続ける（削除とは異なる操作）。締め切りの取り消し（再度開ける機能）は
    対象外——締め切りは一方向の操作として単純化した。voteと同じく更新後のpoll payloadを返す。"""
    pool = get_pool()
    poll_row = await _fetch_poll_with_scope(pool, poll_id)
    if poll_row is None:
        raise HTTPException(404, detail="アンケートが見つかりません")
    await _require_poll_participant(pool, poll_row, user.id)
    if poll_row["created_by"] != user.id and user.role != "admin":
        raise HTTPException(403, detail="このアンケートを締め切る権限がありません")
    if poll_row["closed_at"] is not None:
        raise HTTPException(400, detail="既に締め切られています")
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("UPDATE polls SET closed_at = now() WHERE id = $1", poll_id)
        await conn.execute("UPDATE messages SET updated_at = now() WHERE id = $1", poll_row["message_id"])
        result = await polls.fetch_polls_grouped(conn, [poll_row["message_id"]], user.id)
    return result[poll_row["message_id"]]
