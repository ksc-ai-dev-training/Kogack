# アンケート機能（ユーザーからの明示的な要望「チャットアプリに新しくアンケート機能を付けて
# ほしい」、2026-09-18）用の共通処理。attachments.py・reactions.py・mentions.pyと同じ構成
# （routers/channels.py・dms.py・messages.pyの3箇所から共通で呼び出すgrouped fetch）で、
# アンケートは「messages.idに紐づく付随データ」として実装する（T-29 polls/poll_options/
# poll_votes、database.pyのテーブル定義コメント参照）。質問文はpolls側に重複して持たず、
# 常にmessages.bodyを唯一の情報源として扱う。
from pydantic import BaseModel, Field

MIN_OPTIONS = 2
MAX_OPTIONS = 10


class PollOptionInput(BaseModel):
    label: str = Field(min_length=1, max_length=100)


class PollInput(BaseModel):
    question: str = Field(min_length=1, max_length=4000)  # 通常のメッセージ本文と同じ上限
    options: list[PollOptionInput] = Field(min_length=MIN_OPTIONS, max_length=MAX_OPTIONS)


async def create_poll_message(
    conn, *, channel_id: int | None, dm_id: int | None, sender_user_id: int, poll: PollInput,
) -> dict:
    """アンケートを新規の発言として作成する（channels.py・dms.pyの両方から同じトランザクション内で
    呼ぶ）。質問文はmessages.bodyへそのまま保存し、通常の発言と同じく横断検索・メンション表示等が
    自然に機能するようにする。戻り値はfetch_polls_grouped等と同じ形の1件分のアンケートpayload
    （呼び出し元がそのまま_message_outへ渡せる）。"""
    message_row = await conn.fetchrow(
        """INSERT INTO messages (channel_id, dm_id, sender_type, sender_user_id, body)
           VALUES ($1, $2, 'human', $3, $4) RETURNING *""",
        channel_id, dm_id, sender_user_id, poll.question,
    )
    poll_row = await conn.fetchrow(
        "INSERT INTO polls (message_id, created_by) VALUES ($1, $2) RETURNING *",
        message_row["id"], sender_user_id,
    )
    for i, opt in enumerate(poll.options):
        await conn.execute(
            "INSERT INTO poll_options (poll_id, label, sort_order) VALUES ($1, $2, $3)",
            poll_row["id"], opt.label, i,
        )
    poll_payload = (await fetch_polls_grouped(conn, [message_row["id"]], sender_user_id)).get(message_row["id"])
    return message_row, poll_payload


async def fetch_polls_grouped(pool, message_ids: list[int], current_user_id: int) -> dict[int, dict]:
    """複数メッセージ分のアンケートをまとめて取得する（attachments.fetch_attachments_grouped等と
    同じくA-10/A-13/A-18のN+1回避）。poolはasyncpgのPool・Connectionのいずれでも良い（.fetch()の
    インターフェースが同じため。create_poll_messageはトランザクション中のconnをそのまま渡す）。
    アンケートを持たない発言はこの戻り値のdictに含まれない（フロントは`poll`フィールドの有無で
    通常の発言と区別する）。"""
    if not message_ids:
        return {}
    poll_rows = await pool.fetch(
        "SELECT * FROM polls WHERE message_id = ANY($1::bigint[])", message_ids,
    )
    if not poll_rows:
        return {}
    poll_ids = [p["id"] for p in poll_rows]
    option_rows = await pool.fetch(
        "SELECT * FROM poll_options WHERE poll_id = ANY($1::bigint[]) ORDER BY poll_id, sort_order",
        poll_ids,
    )
    vote_rows = await pool.fetch(
        """SELECT v.poll_id, v.option_id, v.user_id, u.name AS user_name
           FROM poll_votes v JOIN users u ON u.id = v.user_id
           WHERE v.poll_id = ANY($1::bigint[])
           ORDER BY v.voted_at""",
        poll_ids,
    )

    voters_by_option: dict[int, list[str]] = {}
    my_option_by_poll: dict[int, int] = {}
    for v in vote_rows:
        voters_by_option.setdefault(v["option_id"], []).append(v["user_name"])
        if v["user_id"] == current_user_id:
            my_option_by_poll[v["poll_id"]] = v["option_id"]

    options_by_poll: dict[int, list] = {}
    for o in option_rows:
        options_by_poll.setdefault(o["poll_id"], []).append(o)

    result: dict[int, dict] = {}
    for p in poll_rows:
        opts = options_by_poll.get(p["id"], [])
        total_votes = sum(len(voters_by_option.get(o["id"], [])) for o in opts)
        my_option_id = my_option_by_poll.get(p["id"])
        result[p["message_id"]] = {
            "id": str(p["id"]),
            "created_by": str(p["created_by"]) if p["created_by"] is not None else None,
            "closed_at": p["closed_at"].isoformat() if p["closed_at"] else None,
            "total_votes": total_votes,
            "my_option_id": str(my_option_id) if my_option_id is not None else None,
            "options": [
                {
                    "id": str(o["id"]),
                    "label": o["label"],
                    "vote_count": len(voters_by_option.get(o["id"], [])),
                    "voter_names": voters_by_option.get(o["id"], []),
                }
                for o in opts
            ],
        }
    return result
