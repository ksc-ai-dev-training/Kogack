# A-20（詳細設計書 API設計4.5節・6章、基本設計書 S-05横断検索・F-42）
# メッセージ・ファイル（F-07実装によりA-21/A-22が揃ったため対応）を実装する。ドキュメント根拠
# （第2層AI・Drive連携）はまだ実装していないため、counts.documentは常に0、type=documentのitemsは
# 常に空を返す（6.4節の応答形状は維持しつつ、未実装部分だけ0件で応える）。
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query

from auth_helpers import CurrentUser, require_auth
from database import get_pool

router = APIRouter(prefix="/api/search", tags=["search"])

JST = ZoneInfo("Asia/Tokyo")
PAGE_SIZE = 20


def _parse_terms(q: str) -> list[str]:
    """"…"はフレーズのまま1条件、それ以外は空白区切りでAND結合（6.5節）。
    フロントのトークン分解を信頼せずサーバー側でも独自に再パースする（6.5節「設計判断」）。"""
    import re

    terms: list[str] = []
    for m in re.finditer(r'"([^"]+)"|(\S+)', q):
        phrase, word = m.group(1), m.group(2)
        term = phrase if phrase is not None else word
        if term:
            terms.append(term)
    return terms


def _as_id(value: str | None) -> int | None:
    """in/from/withはidの形式（数値）のみを受け付け、それ以外は無視する（400にはしない。6.5節）"""
    if value is not None and value.isdigit():
        return int(value)
    return None


def _as_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _as_month(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(f"{value}-01")
    except ValueError:
        return None


def _excerpt(body: str, terms: list[str], limit: int = 80) -> str:
    text = body.replace("\n", " ")
    if len(text) <= limit:
        return text
    # 検索語が先頭limit文字に収まらない場合、素朴に先頭limit文字を切り出すと
    # ヒット箇所自体が表示されない（フロントのハイライト表示が効かなくなる）ため、最初にヒットした
    # 検索語を中心にスニペットを切り出す（ILIKE同様に大文字小文字を区別しない）
    lower = text.lower()
    match_start: int | None = None
    match_end = 0
    for term in terms:
        needle = term.lower()
        if not needle:
            continue
        idx = lower.find(needle)
        if idx != -1 and (match_start is None or idx < match_start):
            match_start, match_end = idx, idx + len(needle)
    # match_startだけでなくmatch_end（語の終端）もlimit以内に収まっているかを見る。
    # 語の先頭がlimit未満でも終端がlimitを超える場合、素朴な先頭切り出しでは語が途中で切れるため
    if match_start is None or match_end <= limit:
        return text[:limit] + "…"
    start = max(0, match_start - limit // 2)
    end = min(len(text), start + limit)
    if match_end > end:  # 窓を広げてもなお終端が収まらない場合の保険
        end = min(len(text), match_end)
        start = max(0, end - limit)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    return prefix + text[start:end] + suffix


def _build_conditions(
    user_id: int, term_column: str, terms: list[str], in_id, with_id, from_id,
    after_date, before_date, on_date, during_month,
) -> tuple[list[str], list]:
    """m.body（メッセージ検索）・ma.file_name（ファイル検索、F-07）のどちらでも使う共通のin/from/with/
    日付系条件の組み立て（6.5節）。term_columnだけを差し替えて2種類の検索に使い回す。"""
    params: list = [user_id]
    conditions = ["m.deleted_at IS NULL", "(cm.user_id IS NOT NULL OR dmm.user_id IS NOT NULL)"]

    for term in terms:
        params.append(term)
        conditions.append(f"{term_column} ILIKE '%' || ${len(params)} || '%'")
    if in_id is not None:
        params.append(in_id)
        conditions.append(f"m.channel_id = ${len(params)}")
    if with_id is not None:
        params.append(with_id)
        conditions.append(
            f"m.dm_id IN (SELECT dm_id FROM direct_message_members WHERE user_id = ${len(params)})"
        )
    if from_id is not None:
        params.append(from_id)
        conditions.append(f"m.sender_user_id = ${len(params)}")
    if after_date is not None:
        params.append(datetime.combine(after_date + timedelta(days=1), time.min, tzinfo=JST))
        conditions.append(f"m.created_at >= ${len(params)}")
    if before_date is not None:
        params.append(datetime.combine(before_date, time.min, tzinfo=JST))
        conditions.append(f"m.created_at < ${len(params)}")
    if on_date is not None:
        start = datetime.combine(on_date, time.min, tzinfo=JST)
        params.append(start)
        conditions.append(f"m.created_at >= ${len(params)}")
        params.append(start + timedelta(days=1))
        conditions.append(f"m.created_at < ${len(params)}")
    if during_month is not None:
        start = datetime.combine(during_month, time.min, tzinfo=JST)
        end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
        params.append(start)
        conditions.append(f"m.created_at >= ${len(params)}")
        params.append(end)
        conditions.append(f"m.created_at < ${len(params)}")
    return conditions, params


async def _resolve_dm_labels(pool, dm_ids: set[int], self_user_id: int) -> dict[int, str]:
    if not dm_ids:
        return {}
    rows = await pool.fetch(
        """SELECT m.dm_id, u.name FROM direct_message_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.dm_id = ANY($1::bigint[]) AND u.id <> $2 ORDER BY u.name""",
        list(dm_ids), self_user_id,
    )
    members: dict[int, list[str]] = {}
    for r in rows:
        members.setdefault(r["dm_id"], []).append(r["name"])
    return {dm_id: "、".join(names) for dm_id, names in members.items()}


@router.get("")
async def search(
    q: str = "",
    type: str = "all",
    page: int = 1,
    in_: str | None = Query(None, alias="in"),
    from_: str | None = Query(None, alias="from"),
    with_: str | None = Query(None, alias="with"),
    before: str | None = None,
    after: str | None = None,
    on: str | None = None,
    during: str | None = None,
    user: CurrentUser = Depends(require_auth),
):
    pool = get_pool()
    terms = _parse_terms(q)
    in_id = _as_id(in_)
    from_id = _as_id(from_)
    with_id = _as_id(with_)
    after_date, before_date = _as_date(after), _as_date(before)
    on_date, during_month = _as_date(on), _as_month(during)
    offset = max(page, 1) - 1

    joins = """FROM messages m
        LEFT JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = $1
        LEFT JOIN direct_message_members dmm ON dmm.dm_id = m.dm_id AND dmm.user_id = $1"""

    # --- メッセージ検索 ---
    msg_conditions, msg_params = _build_conditions(
        user.id, "m.body", terms, in_id, with_id, from_id, after_date, before_date, on_date, during_month,
    )
    msg_where = " AND ".join(msg_conditions)
    message_count = await pool.fetchval(f"SELECT count(*) {joins} WHERE {msg_where}", *msg_params)

    items: list[dict] = []
    if type in ("all", "message"):
        rows = await pool.fetch(
            f"""SELECT m.id, m.channel_id, m.dm_id, m.body, m.created_at,
                       m.sender_type, m.sender_user_id, m.bot_display_name, m.bot_icon, m.bot_icon_url,
                       c.name AS channel_name, u.name AS sender_name, u.picture_url AS sender_picture_url
                {joins}
                LEFT JOIN channels c ON c.id = m.channel_id
                LEFT JOIN users u ON u.id = m.sender_user_id
                WHERE {msg_where}
                ORDER BY m.created_at DESC LIMIT ${len(msg_params) + 1} OFFSET ${len(msg_params) + 2}""",
            *msg_params, PAGE_SIZE, offset * PAGE_SIZE,
        )
        dm_labels = await _resolve_dm_labels(
            pool, {r["dm_id"] for r in rows if r["dm_id"] is not None}, user.id,
        )
        items += [
            {
                "type": "message",
                "message_id": str(r["id"]),
                "channel_id": str(r["channel_id"]) if r["channel_id"] is not None else None,
                "channel_name": r["channel_name"],
                "dm_id": str(r["dm_id"]) if r["dm_id"] is not None else None,
                "dm_label": dm_labels.get(r["dm_id"]) if r["dm_id"] is not None else None,
                # BOT/AI発言（いずれもsender_user_id無し）はbot_display_nameを表示名として使う
                # （channels.py等の_message_outと同じ分岐。従来この分岐が無く、検索結果のAI/BOT発言の
                # 発言者名が常にnull＝「(不明)」表示になっていたバグをbackfill）
                "sender_display_name": r["bot_display_name"] if r["sender_type"] in ("bot", "ai") else r["sender_name"],
                # 検索結果にも発言者アイコンを表示する（ユーザーからの明示的な要望）。
                # _message_out（channels.py等）と全く同じ優先順位: AI/BOTはbot_icon_url→絵文字→既定表示、
                # 人間はpicture_url→色付き頭文字。sender_type・sender_user_idもフロントのAvatar共有
                # コンポーネントがフォールバック描画の分岐・色決定に使うため、あわせて返す
                "sender_type": r["sender_type"],
                "sender_user_id": str(r["sender_user_id"]) if r["sender_user_id"] is not None else None,
                "sender_picture_url": r["bot_icon_url"] if r["sender_type"] in ("ai", "bot") else r["sender_picture_url"],
                "bot_icon": r["bot_icon"] if r["sender_type"] == "bot" else None,
                "excerpt": _excerpt(r["body"], terms),
                "posted_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]

    # --- ファイル検索（F-07。T-06 message_attachmentsをmessagesに結合しchannel_id/dm_id/
    # sender_user_id/created_atを継承する。file_nameにILIKE、in/with/from/日付系はmessages側の
    # 列で判定する、05-2_詳細設計書_API設計.html「4.5 検索・添付ファイル」の設計どおり） ---
    file_joins = joins + "\n        JOIN message_attachments ma ON ma.message_id = m.id"
    file_conditions, file_params = _build_conditions(
        user.id, "ma.file_name", terms, in_id, with_id, from_id, after_date, before_date, on_date, during_month,
    )
    file_where = " AND ".join(file_conditions)
    file_count = await pool.fetchval(f"SELECT count(*) {file_joins} WHERE {file_where}", *file_params)

    if type in ("all", "file"):
        rows = await pool.fetch(
            f"""SELECT ma.id AS attachment_id, ma.file_name, ma.byte_size,
                       m.channel_id, m.dm_id, m.created_at,
                       m.sender_type, m.sender_user_id, m.bot_display_name, m.bot_icon, m.bot_icon_url,
                       c.name AS channel_name, u.name AS sender_name, u.picture_url AS sender_picture_url
                {file_joins}
                LEFT JOIN channels c ON c.id = m.channel_id
                LEFT JOIN users u ON u.id = m.sender_user_id
                WHERE {file_where}
                ORDER BY m.created_at DESC LIMIT ${len(file_params) + 1} OFFSET ${len(file_params) + 2}""",
            *file_params, PAGE_SIZE, offset * PAGE_SIZE,
        )
        dm_labels = await _resolve_dm_labels(
            pool, {r["dm_id"] for r in rows if r["dm_id"] is not None}, user.id,
        )
        items += [
            {
                "type": "file",
                "attachment_id": str(r["attachment_id"]),
                "file_name": r["file_name"],
                "byte_size": r["byte_size"],
                "channel_id": str(r["channel_id"]) if r["channel_id"] is not None else None,
                "channel_name": r["channel_name"],
                "dm_id": str(r["dm_id"]) if r["dm_id"] is not None else None,
                "dm_label": dm_labels.get(r["dm_id"]) if r["dm_id"] is not None else None,
                # メッセージ検索と同じ理由（BOT/AI発言のsender_display_nameがnullになるバグのbackfill）。
                # 実際には現状BOT/AI発言に添付ファイルが付くことは無いが、他の検索結果と分岐を揃える
                "sender_display_name": r["bot_display_name"] if r["sender_type"] in ("bot", "ai") else r["sender_name"],
                # メッセージ検索と同じくアイコン表示用のフィールドを返す（ユーザーからの明示的な要望）
                "sender_type": r["sender_type"],
                "sender_user_id": str(r["sender_user_id"]) if r["sender_user_id"] is not None else None,
                "sender_picture_url": r["bot_icon_url"] if r["sender_type"] in ("ai", "bot") else r["sender_picture_url"],
                "bot_icon": r["bot_icon"] if r["sender_type"] == "bot" else None,
                "posted_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]

    return {"counts": {"message": message_count, "file": file_count, "document": 0}, "items": items, "page": page}
