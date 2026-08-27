# A-20（詳細設計書 API設計4.5節・6章、基本設計書 S-05横断検索・F-42）
# このスライスはメッセージ検索のみ実装する。ファイル（A-21/A-22 添付ファイル）・
# ドキュメント根拠（第2層AI・Drive連携）はまだ実装していないため、counts.file/counts.documentは常に0、
# type=file/documentのitemsは常に空を返す（6.4節の応答形状は維持しつつ、未実装部分だけ0件で応える）。
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


def _excerpt(body: str, limit: int = 80) -> str:
    text = body.replace("\n", " ")
    return text if len(text) <= limit else text[:limit] + "…"


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

    params: list = [user.id]
    conditions = ["m.deleted_at IS NULL", "(cm.user_id IS NOT NULL OR dmm.user_id IS NOT NULL)"]

    for term in terms:
        params.append(term)
        conditions.append(f"m.body ILIKE '%' || ${len(params)} || '%'")
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

    joins = """FROM messages m
        LEFT JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id = $1
        LEFT JOIN direct_message_members dmm ON dmm.dm_id = m.dm_id AND dmm.user_id = $1"""
    where_clause = " AND ".join(conditions)

    message_count = await pool.fetchval(f"SELECT count(*) {joins} WHERE {where_clause}", *params)

    items: list[dict] = []
    if type in ("all", "message"):
        offset = max(page, 1) - 1
        rows = await pool.fetch(
            f"""SELECT m.id, m.channel_id, m.dm_id, m.body, m.created_at,
                       c.name AS channel_name, u.name AS sender_name
                {joins}
                LEFT JOIN channels c ON c.id = m.channel_id
                LEFT JOIN users u ON u.id = m.sender_user_id
                WHERE {where_clause}
                ORDER BY m.created_at DESC LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}""",
            *params, PAGE_SIZE, offset * PAGE_SIZE,
        )

        dm_ids = {r["dm_id"] for r in rows if r["dm_id"] is not None}
        dm_members: dict[int, list[str]] = {}
        if dm_ids:
            member_rows = await pool.fetch(
                """SELECT m.dm_id, u.name FROM direct_message_members m
                   JOIN users u ON u.id = m.user_id
                   WHERE m.dm_id = ANY($1::bigint[]) AND u.id <> $2 ORDER BY u.name""",
                list(dm_ids), user.id,
            )
            for r in member_rows:
                dm_members.setdefault(r["dm_id"], []).append(r["name"])
        dm_labels = {dm_id: "、".join(names) for dm_id, names in dm_members.items()}

        items = [
            {
                "type": "message",
                "message_id": str(r["id"]),
                "channel_id": str(r["channel_id"]) if r["channel_id"] is not None else None,
                "channel_name": r["channel_name"],
                "dm_id": str(r["dm_id"]) if r["dm_id"] is not None else None,
                "dm_label": dm_labels.get(r["dm_id"]) if r["dm_id"] is not None else None,
                "sender_display_name": r["sender_name"],
                "excerpt": _excerpt(r["body"]),
                "posted_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]

    return {"counts": {"message": message_count, "file": 0, "document": 0}, "items": items, "page": page}
