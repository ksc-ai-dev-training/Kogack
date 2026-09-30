# アンケート機能（T-29 polls/poll_options/poll_votes、要件定義書上のF-xxに対応付けられていない
# 新規機能。ユーザーからの明示的な要望「チャットアプリに新しくアンケート機能を付けてほしい」、
# 2026-09-18）。作成はchannels.py・dms.pyの投稿系エンドポイントに委ねる（アンケートは「新規発言
# として投稿する」操作のため、通常の投稿と同じ参加者チェック・投稿経路を再利用できる）。この
# ルーターは投票・締め切りという、poll_idを直接指定する操作のみを扱う（routers/attachments.pyの
# A-22ダウンロードが/api/attachments/{id}というチャンネル/DMをまたぐ独立エンドポイントなのと
# 同じ構成）。
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import polls
from auth_helpers import CurrentUser, require_auth
from database import get_pool

router = APIRouter(prefix="/api/polls", tags=["polls"])


async def _fetch_poll_with_scope(pool, poll_id: int):
    """アンケートの所属するchannel_id/dm_idもあわせて取得する（参加者チェック用）。元の発言が
    削除済みのアンケートは見つからない扱いにする（2026-09-29バグ修正。従来は削除後も投票・
    締め切りができ、画面に出ない発言のupdated_atだけが進んでいた）"""
    return await pool.fetchrow(
        """SELECT p.*, m.channel_id, m.dm_id FROM polls p
           JOIN messages m ON m.id = p.message_id
           WHERE p.id = $1 AND m.deleted_at IS NULL""",
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
    """投票する。単一選択のアンケートでは、既に投票済みの場合は新しい選択肢へ上書きする（＝投票の
    やり直し）。複数回答を許可したアンケート（allow_multiple、2026-09-30追加）では、押した選択肢の
    投票・取り消しを切り替える（絵文字リアクションと同じトグル）。投票できるのはそのアンケートが投稿されたチャンネル・DMの参加者のみ、かつ
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
    if poll_row["kind"] != "choice":
        raise HTTPException(400, detail="日程調整には投票ではなく回答で答えてください")
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
        # 同じアンケートへの投票を1件ずつ順に処理する。単一選択の「1人1票」はDBの主キーではなく
        # 下の「自分の票を消してから入れる」で保証しているため、連打等で2つの投票が同時に走ると
        # 2票入ってしまうのを防ぐ
        await conn.execute("SELECT 1 FROM polls WHERE id = $1 FOR UPDATE", poll_id)
        if poll_row["allow_multiple"]:
            removed = await conn.fetchval(
                "DELETE FROM poll_votes WHERE option_id = $1 AND user_id = $2 RETURNING 1", option_id, user.id,
            )
            if not removed:
                await conn.execute(
                    "INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES ($1, $2, $3)",
                    poll_id, option_id, user.id,
                )
        else:
            await conn.execute(
                "DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2 AND option_id <> $3",
                poll_id, user.id, option_id,
            )
            await conn.execute(
                """INSERT INTO poll_votes (poll_id, option_id, user_id) VALUES ($1, $2, $3)
                   ON CONFLICT (option_id, user_id) DO NOTHING""",
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


# ---- 日程調整（polls.kind='schedule'、T-32、ユーザーからの明示的な要望、2026-09-30） ----


class ScheduleResponseRequest(BaseModel):
    # 候補id→'yes'/'maybe'/'no'。全候補ぶんを1回で送る（調整さん等と同じ「自分の行をまとめて
    # 保存する」操作。候補ごとに1クリック1APIにすると、途中まで入れた状態が他の参加者に見えてしまう）
    answers: dict[str, Literal["yes", "maybe", "no"]]
    comment: str = Field(default="", max_length=200)


async def _require_schedule(pool, poll_id: int, user_id: int):
    poll_row = await _fetch_poll_with_scope(pool, poll_id)
    if poll_row is None:
        raise HTTPException(404, detail="日程調整が見つかりません")
    await _require_poll_participant(pool, poll_row, user_id)
    if poll_row["kind"] != "schedule":
        raise HTTPException(400, detail="日程調整ではありません")
    return poll_row


@router.put("/{poll_id}/schedule-response")
async def respond_schedule(poll_id: int, body: ScheduleResponseRequest, user: CurrentUser = Depends(require_auth)):
    """日程調整に回答する（参加者なら誰でも。回答済みなら上書き＝回答のやり直し）。全候補に○△×の
    いずれかが付いていることを要求する（未回答の候補が混ざると集計の「○が最多」の比較が回答漏れに
    引きずられるため）。voteと同じくmessages.updated_atを進め、更新後のpayloadを返す"""
    pool = get_pool()
    poll_row = await _require_schedule(pool, poll_id, user.id)
    if poll_row["closed_at"] is not None:
        raise HTTPException(400, detail="この日程調整は締め切られています")
    option_ids = {
        str(r["id"]) for r in await pool.fetch("SELECT id FROM poll_options WHERE poll_id = $1", poll_id)
    }
    if set(body.answers) != option_ids:
        raise HTTPException(422, detail="すべての候補日程に○△×のいずれかを選んでください")
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(
            """INSERT INTO poll_schedule_respondents (poll_id, user_id, comment) VALUES ($1, $2, $3)
               ON CONFLICT (poll_id, user_id) DO UPDATE SET comment = $3""",
            poll_id, user.id, body.comment.strip(),
        )
        for option_id, answer in body.answers.items():
            await conn.execute(
                """INSERT INTO poll_schedule_answers (poll_id, option_id, user_id, answer) VALUES ($1, $2, $3, $4)
                   ON CONFLICT (option_id, user_id) DO UPDATE SET answer = $4""",
                poll_id, int(option_id), user.id, answer,
            )
        await conn.execute("UPDATE messages SET updated_at = now() WHERE id = $1", poll_row["message_id"])
        result = await polls.fetch_polls_grouped(conn, [poll_row["message_id"]], user.id)
    return result[poll_row["message_id"]]


class DecideScheduleRequest(BaseModel):
    option_id: str


@router.post("/{poll_id}/decide")
async def decide_schedule(poll_id: int, body: DecideScheduleRequest, user: CurrentUser = Depends(require_auth)):
    """日程を確定する（作成者本人またはシステム管理者のみ。close_pollと同じ権限）。確定すると同時に
    締め切り（以後は回答不可）、元発言のスレッドへ確定のお知らせを確定した本人の発言として投稿する
    （利用者の合意した仕様「スレッドにも確定のお知らせを自動で投稿する」。システム通知（F-43）は
    返信できないため使わず、参加者がそのまま「了解です」等と返せる通常の返信にする）。確定の
    取り消し・変更は対象外（アンケートの締め切りと同じく一方向の操作として単純化）"""
    pool = get_pool()
    poll_row = await _require_schedule(pool, poll_id, user.id)
    if poll_row["created_by"] != user.id and user.role != "admin":
        raise HTTPException(403, detail="この日程調整を確定する権限がありません")
    if poll_row["closed_at"] is not None:
        raise HTTPException(400, detail="既に確定・締め切り済みです")
    try:
        option_id = int(body.option_id)
    except ValueError:
        raise HTTPException(422, detail="不正な候補日程です") from None
    label = await pool.fetchval(
        "SELECT label FROM poll_options WHERE id = $1 AND poll_id = $2", option_id, poll_id,
    )
    if label is None:
        raise HTTPException(422, detail="不正な候補日程です")
    title = await pool.fetchval("SELECT body FROM messages WHERE id = $1", poll_row["message_id"])
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(
            "UPDATE polls SET closed_at = now(), decided_option_id = $2 WHERE id = $1", poll_id, option_id,
        )
        await conn.execute(
            """INSERT INTO messages (channel_id, dm_id, thread_parent_id, sender_type, sender_user_id, body)
               VALUES ($1, $2, $3, 'human', $4, $5)""",
            poll_row["channel_id"], poll_row["dm_id"], poll_row["message_id"], user.id,
            f"📅 「{title}」の日程を {label} に決定しました。",
        )
        await conn.execute("UPDATE messages SET updated_at = now() WHERE id = $1", poll_row["message_id"])
        result = await polls.fetch_polls_grouped(conn, [poll_row["message_id"]], user.id)
    return result[poll_row["message_id"]]
