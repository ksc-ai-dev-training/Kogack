# F-35送信予約・F-36定期投稿のディスパッチャ（基本設計書5.15節・5.16節・10章）。FastAPI起動時から
# 稼働する30秒間隔のasyncioバックグラウンドタスクとして実装し、専用ジョブキュー（Celery等）は
# 導入しない（database.py T-18の設計判断コメントと同じ。単一インスタンス運用が前提）。
#
# [F-35] scheduled_at を過ぎた pending 行を検出すると、通常のメッセージ投稿（A-11/A-14/A-19相当）と
# 同じ経路でmessagesへ発言化する。@メンションの構造化（T-07）はscheduled_messages.mentions
# （予約時点の指定をJSONBで保持）をinsert_mention_blocksへ渡し、実際に発言化するこのタイミングで
# 参加者チェック込みでT-07へ反映する（routers/scheduled_messages.pyのコメント参照）。BOT発言の
# 枠組み（F-36/F-38/F-43）とは異なりsender_type='human'として投稿するため、AIサポート実装後は
# 通常どおり@メンションでAIエージェントが起動できる（基本設計書5.15節「実際の送信時点で通常どおり
# トリガーされる」）。
#
# [F-36] is_active=true かつ next_run_at<=now() の定期投稿ルールを検出すると、sender_type='bot'の
# 発言を作成し、頻度に応じてnext_run_atを次回時刻へ進める（'once'はis_active=falseに変更して
# 終了する）。アプリの停止等でnext_run_atを過ぎても検出できなかった場合、次回起動時のポーリングで
# 直ちに送信する（欠落回をスキップしない。F-35と同じ考え方、基本設計書5.16節）。
import asyncio
import calendar
import json
import traceback
from datetime import datetime, timedelta

from database import get_pool
from mentions import MentionInput, insert_mention_blocks

POLL_INTERVAL_SECONDS = 30

_task: asyncio.Task | None = None


def _next_run_after(current: datetime, anchor: datetime, frequency: str) -> datetime:
    """'weekly'は初回日時の曜日、'monthly'は初回日時（anchor）の日にちを基準に次回時刻を計算する
    （画面モックアップS-06の説明どおり）。'monthly'で該当日が存在しない月（例: 31日起点の2月）は
    月末に繰り下げる（基本設計書6.2節「設計判断」、T-19 recurring_postsの同種の既存記載と同じ考え方）。
    時刻（時分秒）はcurrent（＝直前のnext_run_at）のものをそのまま維持する。"""
    if frequency == "daily":
        return current + timedelta(days=1)
    if frequency == "weekly":
        return current + timedelta(days=7)
    if frequency == "monthly":
        year = current.year + (current.month // 12)
        month = current.month % 12 + 1
        last_day = calendar.monthrange(year, month)[1]
        day = min(anchor.day, last_day)
        return current.replace(year=year, month=month, day=day)
    raise ValueError(f"unsupported frequency: {frequency}")


async def _dispatch_due_messages() -> None:
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT id, channel_id, dm_id, thread_parent_id, sender_user_id, body, mentions
           FROM scheduled_messages WHERE status = 'pending' AND scheduled_at <= now()"""
    )
    for row in rows:
        async with pool.acquire() as conn, conn.transaction():
            # 単一インスタンス運用が前提のため通常は競合しないが、念のため取得と同時に
            # status='pending'を条件にUPDATEし、二重発言化を防ぐ（基本設計書10章「設計判断」）。
            claimed = await conn.fetchval(
                "UPDATE scheduled_messages SET status = 'sent', sent_at = now() "
                "WHERE id = $1 AND status = 'pending' RETURNING id",
                row["id"],
            )
            if claimed is None:
                continue
            message_row = await conn.fetchrow(
                """INSERT INTO messages (channel_id, dm_id, thread_parent_id, sender_type, sender_user_id, body)
                   VALUES ($1, $2, $3, 'human', $4, $5) RETURNING id""",
                row["channel_id"], row["dm_id"], row["thread_parent_id"], row["sender_user_id"], row["body"],
            )
            if row["channel_id"] is not None:
                raw_mentions = row["mentions"]
                mentions_data = json.loads(raw_mentions) if isinstance(raw_mentions, str) else raw_mentions
                if mentions_data:
                    await insert_mention_blocks(
                        conn, message_row["id"], row["channel_id"],
                        [MentionInput(**m) for m in mentions_data],
                    )


async def _dispatch_recurring_posts() -> None:
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT id, channel_id, body, bot_display_name, bot_icon, bot_icon_url,
                  frequency, anchor_at, next_run_at
           FROM recurring_posts WHERE is_active = true AND next_run_at <= now()"""
    )
    for row in rows:
        async with pool.acquire() as conn, conn.transaction():
            # scheduled_messagesと同じ「取得と同時に次の状態へUPDATEし、その結果で二重発言化を
            # 防ぐ」パターン。ここでの「次の状態」はnext_run_atを未来へ進める（'once'はis_active
            # をfalseにする）こと自体で、専用のstatus列は持たない（recurring_postsは削除するまで
            # 繰り返し処理対象であり続けるため、scheduled_messagesのような使い捨てのpending/sentとは
            # 性質が異なる）。
            if row["frequency"] == "once":
                claimed = await conn.fetchval(
                    """UPDATE recurring_posts SET is_active = false, last_sent_at = now()
                       WHERE id = $1 AND is_active = true AND next_run_at <= now() RETURNING id""",
                    row["id"],
                )
            else:
                next_run_at = _next_run_after(row["next_run_at"], row["anchor_at"], row["frequency"])
                claimed = await conn.fetchval(
                    """UPDATE recurring_posts SET next_run_at = $2, last_sent_at = now()
                       WHERE id = $1 AND is_active = true AND next_run_at <= now() RETURNING id""",
                    row["id"], next_run_at,
                )
            if claimed is None:
                continue
            await conn.execute(
                """INSERT INTO messages
                       (channel_id, sender_type, body, bot_display_name, bot_icon, bot_icon_url, recurring_post_id)
                   VALUES ($1, 'bot', $2, $3, $4, $5, $6)""",
                row["channel_id"], row["body"], row["bot_display_name"], row["bot_icon"],
                row["bot_icon_url"], row["id"],
            )


async def _run_loop() -> None:
    while True:
        try:
            await _dispatch_due_messages()
            await _dispatch_recurring_posts()
        except Exception:
            # 1回の失敗でループ自体を止めない（次の30秒後に再試行される）
            traceback.print_exc()
        await asyncio.sleep(POLL_INTERVAL_SECONDS)


def start() -> None:
    global _task
    if _task is None:
        _task = asyncio.create_task(_run_loop())


async def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
        _task = None
