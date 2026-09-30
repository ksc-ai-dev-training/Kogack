# AI利用コストの上限（T-14 ai_usage_limits、F-29後半・REQ-N-03「把握・制限」の「制限」側）。
# 2026-09-30、ユーザーと合意した方式:
#   - 上限額に達したときの動作は設定（on_limit_action）で選ぶ。'notify'（既定）は通知だけで応答を
#     続け、'stop'はその範囲（全体上限なら全チャンネル、チャンネル別上限ならそのチャンネル）のAIを
#     月末まで止める。どちらにするかは要件定義書8.2節のとおり千田氏との協議事項のため、結論が出たら
#     設定を切り替えるだけで反映できるようにしてある。
#   - しきい値（notify_threshold_pct、既定80%）到達と上限到達を、それぞれその月に初めて達した時点で
#     1回だけ、システム管理者全員の自分専用DM（F-05「自分（メモ）」）へシステム通知として送る。
#     メールではない（Kogackにメール送信基盤が無いため。ユーザーの選択）。
# 使用額はT-13 ai_usage_logs.estimated_cost_yenの当月（JST）合計で、A-42（管理コンソールの集計）と同じ。
from datetime import datetime, time
from zoneinfo import ZoneInfo

from database import get_pool

JST = ZoneInfo("Asia/Tokyo")
NOTICE_SENDER = "システム通知"
STOPPED_REPLY = (
    "今月のAI利用コストが上限額に達したため、月末までAIの応答を停止しています"
    "（管理者の設定による）。詳しくはシステム管理者にお問い合わせください。"
)


def _month_bounds() -> tuple[datetime, datetime, str]:
    today = datetime.now(JST).date()
    start = datetime.combine(today.replace(day=1), time.min, tzinfo=JST)
    end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
    return start, end, f"{start.year:04d}-{start.month:02d}"


async def _month_cost(conn, channel_id: int | None, start: datetime, end: datetime) -> float:
    """当月の使用額。channel_id=Noneなら全体、指定時はそのチャンネル分のみ"""
    if channel_id is None:
        value = await conn.fetchval(
            "SELECT COALESCE(sum(estimated_cost_yen), 0) FROM ai_usage_logs WHERE created_at >= $1 AND created_at < $2",
            start, end,
        )
    else:
        value = await conn.fetchval(
            """SELECT COALESCE(sum(estimated_cost_yen), 0) FROM ai_usage_logs
               WHERE channel_id = $1 AND created_at >= $2 AND created_at < $3""",
            channel_id, start, end,
        )
    return float(value)


async def _applicable_limits(conn, channel_id: int | None) -> list:
    """このチャンネルに関係する上限（全体上限と、そのチャンネルの上限）"""
    return await conn.fetch(
        """SELECT l.*, c.name AS channel_name FROM ai_usage_limits l
           LEFT JOIN channels c ON c.id = l.channel_id
           WHERE l.scope = 'global' OR (l.scope = 'channel' AND l.channel_id = $1)""",
        channel_id,
    )


async def is_stopped(channel_id: int | None) -> bool:
    """このチャンネルのAIが上限到達により停止中か（on_limit_action='stop'の上限に今月達している）。
    AIを呼び出す前に確認する（呼び出してから止めても、その1回分のコストは既に掛かっているため）"""
    pool = get_pool()
    start, end, _ = _month_bounds()
    async with pool.acquire() as conn:
        for row in await _applicable_limits(conn, channel_id):
            if row["on_limit_action"] != "stop":
                continue
            scope_channel = None if row["scope"] == "global" else row["channel_id"]
            if await _month_cost(conn, scope_channel, start, end) >= float(row["monthly_limit_yen"]):
                return True
    return False


async def _self_dm_id(conn, user_id: int) -> int:
    """その利用者の自分専用DM（参加者が本人だけのDM）。無ければ作る（A-17と同じ判定・作成方法）"""
    dm_id = await conn.fetchval(
        """SELECT dm_id FROM direct_message_members
           GROUP BY dm_id
           HAVING array_agg(user_id ORDER BY user_id) = ARRAY[$1::bigint]""",
        user_id,
    )
    if dm_id is not None:
        return dm_id
    dm_id = await conn.fetchval("INSERT INTO direct_messages (created_by) VALUES ($1) RETURNING id", user_id)
    await conn.execute("INSERT INTO direct_message_members (dm_id, user_id) VALUES ($1, $2)", dm_id, user_id)
    return dm_id


async def _notify_admins(conn, text: str) -> None:
    for admin in await conn.fetch("SELECT id FROM users WHERE role = 'admin' AND is_active"):
        dm_id = await _self_dm_id(conn, admin["id"])
        await conn.execute(
            "INSERT INTO messages (dm_id, sender_type, bot_display_name, body) VALUES ($1, 'bot', $2, $3)",
            dm_id, NOTICE_SENDER, text,
        )


def _yen(v: float) -> str:
    return f"{v:,.0f}円"


def _notice_text(row, cost: float, limit: float, reached: bool) -> str:
    target = "全体" if row["scope"] == "global" else f"# {row['channel_name'] or '(削除済みチャンネル)'} "
    head = f"【AI利用コスト】{target}の今月のAI利用コストが"
    usage = f"（今月 {_yen(cost)}／上限 {_yen(limit)}）"
    if not reached:
        return (
            f"{head}上限額の{row['notify_threshold_pct']}%に達しました{usage}。"
            "管理コンソールの「AI利用状況・コスト」で内訳を確認できます。"
        )
    scope_label = "全チャンネル" if row["scope"] == "global" else "このチャンネル"
    action = (
        f"設定により、{scope_label}のAIは月末まで応答を停止します。"
        if row["on_limit_action"] == "stop"
        else "設定（通知のみ）により、AIは引き続き応答します。"
    )
    return f"{head}上限額に達しました{usage}。{action}管理コンソールの「AI利用状況・コスト」で設定を変更できます。"


async def check_and_notify(channel_id: int | None) -> None:
    """AI利用ログ（T-13）を記録した直後に呼ぶ。関係する上限について、しきい値・上限への到達を
    その月に初めて検知したときだけシステム管理者へ通知する。同時に複数の応答が完了しても二重に
    送らないよう、通知済みの月を条件付きUPDATEで先に確定させた側だけが送る"""
    pool = get_pool()
    start, end, month = _month_bounds()
    async with pool.acquire() as conn:
        for row in await _applicable_limits(conn, channel_id):
            limit = float(row["monthly_limit_yen"])
            if limit <= 0:
                continue
            scope_channel = None if row["scope"] == "global" else row["channel_id"]
            cost = await _month_cost(conn, scope_channel, start, end)
            if cost >= limit:
                # 上限到達。しきい値の通知も同時に済んだ扱いにする（一度に2通送らない）
                claimed = await conn.fetchval(
                    """UPDATE ai_usage_limits SET limit_notified_month = $2, threshold_notified_month = $2
                       WHERE id = $1 AND limit_notified_month IS DISTINCT FROM $2 RETURNING id""",
                    row["id"], month,
                )
                if claimed:
                    await _notify_admins(conn, _notice_text(row, cost, limit, reached=True))
            elif cost >= limit * row["notify_threshold_pct"] / 100:
                claimed = await conn.fetchval(
                    """UPDATE ai_usage_limits SET threshold_notified_month = $2
                       WHERE id = $1 AND threshold_notified_month IS DISTINCT FROM $2 RETURNING id""",
                    row["id"], month,
                )
                if claimed:
                    await _notify_admins(conn, _notice_text(row, cost, limit, reached=False))
