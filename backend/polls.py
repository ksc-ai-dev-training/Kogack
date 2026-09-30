# アンケート機能（ユーザーからの明示的な要望「チャットアプリに新しくアンケート機能を付けて
# ほしい」、2026-09-18）用の共通処理。attachments.py・reactions.py・mentions.pyと同じ構成
# （routers/channels.py・dms.py・messages.pyの3箇所から共通で呼び出すgrouped fetch）で、
# アンケートは「messages.idに紐づく付随データ」として実装する（T-29 polls/poll_options/
# poll_votes、database.pyのテーブル定義コメント参照）。質問文はpolls側に重複して持たず、
# 常にmessages.bodyを唯一の情報源として扱う。
# 日程調整（2026-09-30、polls.kind='schedule'・T-32）も同じテーブルの一種として扱い、
# fetch_polls_groupedがkindに応じた形のpayloadを返す。
from datetime import date

from pydantic import BaseModel, Field, model_validator

MIN_OPTIONS = 2
MAX_OPTIONS = 10
# 日程調整の候補数。候補が1件だけでも「この日で良いか」の確認として使えるため下限は1にする
MIN_SCHEDULE_OPTIONS = 1
MAX_SCHEDULE_OPTIONS = 30
SCHEDULE_ANSWERS = ("yes", "maybe", "no")
_WEEKDAYS = "月火水木金土日"


class PollOptionInput(BaseModel):
    label: str = Field(min_length=1, max_length=100)


class PollInput(BaseModel):
    question: str = Field(min_length=1, max_length=4000)  # 通常のメッセージ本文と同じ上限
    options: list[PollOptionInput] = Field(min_length=MIN_OPTIONS, max_length=MAX_OPTIONS)
    # 複数回答を許可するか（2026-09-30追加。既定は従来どおり単一選択）
    allow_multiple: bool = False


class ScheduleInput(BaseModel):
    title: str = Field(min_length=1, max_length=4000)  # messages.bodyへ保存するため通常の本文と同じ上限
    # 候補は日付のみ（当初は任意の開始・終了時刻も選べたが、利用者の判断で同日中に日付のみへ変更。
    # 時刻を伝えたい場合はタイトルに書いてもらう）
    dates: list[date] = Field(min_length=MIN_SCHEDULE_OPTIONS, max_length=MAX_SCHEDULE_OPTIONS)

    @model_validator(mode="after")
    def _check_duplicates(self):
        if len(set(self.dates)) != len(self.dates):
            raise ValueError("同じ候補日が重複しています")
        return self


def format_schedule_label(d: date) -> str:
    """候補日の表示用文字列（「10/3(土)」）。poll_options.labelへ保存し、画面・AIへの履歴・確定の
    お知らせで共通に使う。年は表示しない（候補が年をまたぐことはほぼ無く、並び順はstarts_on列で
    正しく保たれる）"""
    return f"{d.month}/{d.day}({_WEEKDAYS[d.weekday()]})"


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
        "INSERT INTO polls (message_id, created_by, allow_multiple) VALUES ($1, $2, $3) RETURNING *",
        message_row["id"], sender_user_id, poll.allow_multiple,
    )
    for i, opt in enumerate(poll.options):
        await conn.execute(
            "INSERT INTO poll_options (poll_id, label, sort_order) VALUES ($1, $2, $3)",
            poll_row["id"], opt.label, i,
        )
    poll_payload = (await fetch_polls_grouped(conn, [message_row["id"]], sender_user_id)).get(message_row["id"])
    return message_row, poll_payload


async def create_schedule_message(
    conn, *, channel_id: int | None, dm_id: int | None, sender_user_id: int, schedule: ScheduleInput,
) -> dict:
    """日程調整を新規の発言として作成する（create_poll_messageと同じ構成。タイトルをmessages.bodyへ
    保存する）。候補は入力順ではなく日付の早い順に並べて保存する"""
    message_row = await conn.fetchrow(
        """INSERT INTO messages (channel_id, dm_id, sender_type, sender_user_id, body)
           VALUES ($1, $2, 'human', $3, $4) RETURNING *""",
        channel_id, dm_id, sender_user_id, schedule.title,
    )
    poll_row = await conn.fetchrow(
        "INSERT INTO polls (message_id, created_by, kind) VALUES ($1, $2, 'schedule') RETURNING *",
        message_row["id"], sender_user_id,
    )
    for i, d in enumerate(sorted(schedule.dates)):
        await conn.execute(
            "INSERT INTO poll_options (poll_id, label, sort_order, starts_on) VALUES ($1, $2, $3, $4)",
            poll_row["id"], format_schedule_label(d), i, d,
        )
    poll_payload = (await fetch_polls_grouped(conn, [message_row["id"]], sender_user_id)).get(message_row["id"])
    return message_row, poll_payload


def best_schedule_option_ids(options: list[dict]) -> list[str]:
    """最も都合の良い候補（○の人数が最多、同数なら△の人数が多いもの）。誰も○△を付けていない
    段階では空にする（全候補が同点で「最有力」の強調が意味を持たないため）"""
    scored = [(o["yes_count"], o["maybe_count"]) for o in options]
    if not scored or max(scored) == (0, 0):
        return []
    top = max(scored)
    return [o["id"] for o, sc in zip(options, scored) if sc == top]


async def _schedule_payloads(pool, poll_rows, options_by_poll: dict[int, list]) -> dict[int, dict]:
    """日程調整（kind='schedule'）のpayload。回答者ごとの○△×とコメントは参加者全員に見える
    （調整さん等と同じ一覧表の形。既存アンケートの「投票者が見える」方針とも揃う）"""
    if not poll_rows:
        return {}
    poll_ids = [p["id"] for p in poll_rows]
    respondent_rows = await pool.fetch(
        """SELECT r.poll_id, r.user_id, r.comment, u.name AS user_name
           FROM poll_schedule_respondents r JOIN users u ON u.id = r.user_id
           WHERE r.poll_id = ANY($1::bigint[])
           ORDER BY r.responded_at""",
        poll_ids,
    )
    answer_rows = await pool.fetch(
        "SELECT poll_id, option_id, user_id, answer FROM poll_schedule_answers WHERE poll_id = ANY($1::bigint[])",
        poll_ids,
    )
    answers_by_user: dict[tuple[int, int], dict[str, str]] = {}
    for a in answer_rows:
        answers_by_user.setdefault((a["poll_id"], a["user_id"]), {})[str(a["option_id"])] = a["answer"]
    respondents_by_poll: dict[int, list[dict]] = {}
    for r in respondent_rows:
        respondents_by_poll.setdefault(r["poll_id"], []).append({
            "user_id": str(r["user_id"]),
            "user_name": r["user_name"],
            "comment": r["comment"],
            "answers": answers_by_user.get((r["poll_id"], r["user_id"]), {}),
        })

    result: dict[int, dict] = {}
    for p in poll_rows:
        respondents = respondents_by_poll.get(p["id"], [])
        options = []
        for o in options_by_poll.get(p["id"], []):
            oid = str(o["id"])
            counts = dict.fromkeys(SCHEDULE_ANSWERS, 0)
            for resp in respondents:
                ans = resp["answers"].get(oid)
                if ans in counts:
                    counts[ans] += 1
            options.append({
                "id": oid,
                "label": o["label"],
                "starts_on": o["starts_on"].isoformat() if o["starts_on"] else None,
                "yes_count": counts["yes"],
                "maybe_count": counts["maybe"],
                "no_count": counts["no"],
            })
        result[p["message_id"]] = {
            "id": str(p["id"]),
            "kind": "schedule",
            "created_by": str(p["created_by"]) if p["created_by"] is not None else None,
            "closed_at": p["closed_at"].isoformat() if p["closed_at"] else None,
            "decided_option_id": str(p["decided_option_id"]) if p["decided_option_id"] is not None else None,
            # 回答者数（アンケートのtotal_votesと同じ位置づけ）
            "total_votes": len(respondents),
            "options": options,
            "best_option_ids": best_schedule_option_ids(options),
            "respondents": respondents,
        }
    return result


async def fetch_polls_grouped(pool, message_ids: list[int], current_user_id: int) -> dict[int, dict]:
    """複数メッセージ分のアンケートをまとめて取得する（attachments.fetch_attachments_grouped等と
    同じくA-10/A-13/A-18のN+1回避）。poolはasyncpgのPool・Connectionのいずれでも良い（.fetch()の
    インターフェースが同じため。create_poll_messageはトランザクション中のconnをそのまま渡す）。
    アンケートを持たない発言はこの戻り値のdictに含まれない（フロントは`poll`フィールドの有無で
    通常の発言と区別する）。日程調整（kind='schedule'）は回答の形が違うため別の形のpayloadになる
    （フロントはkindで表示を切り替える）。"""
    if not message_ids:
        return {}
    poll_rows = await pool.fetch(
        "SELECT * FROM polls WHERE message_id = ANY($1::bigint[])", message_ids,
    )
    if not poll_rows:
        return {}
    option_rows = await pool.fetch(
        "SELECT * FROM poll_options WHERE poll_id = ANY($1::bigint[]) ORDER BY poll_id, sort_order",
        [p["id"] for p in poll_rows],
    )
    options_by_poll: dict[int, list] = {}
    for o in option_rows:
        options_by_poll.setdefault(o["poll_id"], []).append(o)

    result = await _schedule_payloads(pool, [p for p in poll_rows if p["kind"] == "schedule"], options_by_poll)
    poll_rows = [p for p in poll_rows if p["kind"] != "schedule"]
    if not poll_rows:
        return result
    poll_ids = [p["id"] for p in poll_rows]
    vote_rows = await pool.fetch(
        """SELECT v.poll_id, v.option_id, v.user_id, u.name AS user_name
           FROM poll_votes v JOIN users u ON u.id = v.user_id
           WHERE v.poll_id = ANY($1::bigint[])
           ORDER BY v.voted_at""",
        poll_ids,
    )

    voters_by_option: dict[int, list[str]] = {}
    my_options_by_poll: dict[int, list[int]] = {}
    voter_ids_by_poll: dict[int, set[int]] = {}
    for v in vote_rows:
        voters_by_option.setdefault(v["option_id"], []).append(v["user_name"])
        voter_ids_by_poll.setdefault(v["poll_id"], set()).add(v["user_id"])
        if v["user_id"] == current_user_id:
            my_options_by_poll.setdefault(v["poll_id"], []).append(v["option_id"])

    for p in poll_rows:
        opts = options_by_poll.get(p["id"], [])
        total_votes = sum(len(voters_by_option.get(o["id"], [])) for o in opts)
        result[p["message_id"]] = {
            "id": str(p["id"]),
            "kind": "choice",
            "created_by": str(p["created_by"]) if p["created_by"] is not None else None,
            "closed_at": p["closed_at"].isoformat() if p["closed_at"] else None,
            "allow_multiple": p["allow_multiple"],
            # 票数の合計。複数回答では1人が複数票を入れるため、投票した人数（voter_count）とは一致しない
            "total_votes": total_votes,
            "voter_count": len(voter_ids_by_poll.get(p["id"], ())),
            # 自分が投票した選択肢（単一選択では0〜1件、複数回答では0件以上）
            "my_option_ids": [str(i) for i in my_options_by_poll.get(p["id"], [])],
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
