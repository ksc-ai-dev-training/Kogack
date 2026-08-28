# F-35 送信予約のディスパッチャ（基本設計書5.15節・10章）。FastAPI起動時から稼働する30秒間隔の
# asyncioバックグラウンドタスクとして実装し、専用ジョブキュー（Celery等）は導入しない
# （database.py T-18の設計判断コメントと同じ。単一インスタンス運用が前提）。
#
# scheduled_at を過ぎた pending 行を検出すると、通常のメッセージ投稿（A-11/A-14/A-19相当）と
# 同じ経路でmessagesへ発言化する。@メンションの構造化（T-07）はscheduled_messages.mentions
# （予約時点の指定をJSONBで保持）をinsert_mention_blocksへ渡し、実際に発言化するこのタイミングで
# 参加者チェック込みでT-07へ反映する（routers/scheduled_messages.pyのコメント参照）。BOT発言の
# 枠組み（F-36/F-38/F-43）とは異なりsender_type='human'として投稿するため、AIサポート実装後は
# 通常どおり@メンションでAIエージェントが起動できる（基本設計書5.15節「実際の送信時点で通常どおり
# トリガーされる」）。
import asyncio
import json
import traceback

from database import get_pool
from mentions import MentionInput, insert_mention_blocks

POLL_INTERVAL_SECONDS = 30

_task: asyncio.Task | None = None


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


async def _run_loop() -> None:
    while True:
        try:
            await _dispatch_due_messages()
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
