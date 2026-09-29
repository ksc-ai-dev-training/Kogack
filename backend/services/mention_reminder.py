# メンションの催促（ユーザーからの明示的な要望「メンションを受けたのに一定時間たっても返信も
# リアクションもしていないユーザーに対して、AIが自動的に返信を催促したりリマインドしたりする機能」、
# 2026-09-29。要件定義書上のF-xxに対応付けられていない新規機能）。
#
# 着手前にユーザーへ確認して決めた仕様:
# - 催促は元発言のスレッドへ、チャンネルAIのキャラクタ名・アイコンでAI発言として投稿する
#   （本体タイムラインは流さない）。メンションがスレッド返信の中にあった場合はそのスレッドへ
# - 「反応した」とみなすのは、メンションを含む発言への本人の絵文字リアクション、または同じスレッドへの
#   本人の（メンションより後の）返信
# - 待ち時間と有効/無効はチャンネルごと（T-08 channel_ai_settings.mention_reminder_*、S-06「反応モード」
#   タブ、A-77）。既定はオフ
# - 文面は定型文（AIの利用料はかからない。LLMは呼ばない）
#
# その他の決めごと: 対象はチャンネル内の人間の発言に含まれる個人宛てメンションのみ（@channel/@here・
# DM・BOT/AI発言のメンションは対象外。催促自体がAI発言なので、催促への催促も起きない）。1件の
# メンションにつき催促は1回だけ（T-30 mention_reminders）。チャンネルAIが無効なら催促しない。
# 機能をオンにした時刻（mention_reminder_enabled_at）より前のメンション、および期限から
# STALE_AFTERを超えて過ぎたメンション（アプリの長時間停止明け等）は催促しない。
# 対象者がチャンネルを抜けた・無効化された場合も催促しない。
#
# 判定は services/scheduled_dispatcher.py の30秒間隔ループから呼ぶ（専用ジョブキューは使わない、
# 単一インスタンス運用が前提という既存の設計判断をそのまま踏襲）。
from datetime import timedelta

import background
from database import get_pool
from mentions import MentionInput, insert_mention_blocks
from services import push_sender

STALE_AFTER = timedelta(days=7)
BATCH_LIMIT = 50  # 1回のループで催促する最大件数（大量に溜まっていても1回の処理を長引かせない）

# 催促すべき（発言, 対象者）の組。mention_blocksのpayloadのtarget_user_idは文字列で保存されている
# （mentions.insert_mention_blocks）ため、比較はtext同士で行う
_DUE_SQL = """
SELECT m.id AS message_id, m.channel_id, COALESCE(m.thread_parent_id, m.id) AS root_id,
       u.id AS target_user_id, u.name AS target_name, sender.name AS sender_name,
       s.mention_reminder_hours, s.persona_name, s.persona_icon_url
FROM channel_ai_settings s
JOIN messages m ON m.channel_id = s.channel_id
JOIN message_blocks mb ON mb.message_id = m.id AND mb.block_type = 'mention' AND mb.payload ? 'target_user_id'
JOIN channel_members cm ON cm.channel_id = m.channel_id AND cm.user_id::text = mb.payload->>'target_user_id'
JOIN users u ON u.id = cm.user_id AND u.is_active
LEFT JOIN users sender ON sender.id = m.sender_user_id
LEFT JOIN messages root ON root.id = m.thread_parent_id
WHERE s.mention_reminder_enabled AND s.is_ai_enabled
  AND m.sender_type = 'human' AND m.deleted_at IS NULL
  AND (m.thread_parent_id IS NULL OR root.deleted_at IS NULL)
  AND m.sender_user_id IS DISTINCT FROM u.id
  AND m.created_at >= s.mention_reminder_enabled_at
  AND m.created_at <= now() - make_interval(hours => s.mention_reminder_hours)
  AND m.created_at > now() - make_interval(hours => s.mention_reminder_hours) - $1::interval
  AND NOT EXISTS (SELECT 1 FROM mention_reminders r WHERE r.message_id = m.id AND r.user_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM message_reactions x WHERE x.message_id = m.id AND x.user_id = u.id)
  AND NOT EXISTS (
    SELECT 1 FROM messages rep
    WHERE rep.thread_parent_id = COALESCE(m.thread_parent_id, m.id)
      AND rep.sender_user_id = u.id AND rep.deleted_at IS NULL AND rep.created_at > m.created_at
  )
ORDER BY m.created_at
LIMIT $2
"""


def _elapsed_label(hours: int) -> str:
    return f"{hours // 24}日" if hours % 24 == 0 else f"{hours}時間"


def reminder_body(target_name: str, sender_name: str | None, hours: int) -> str:
    """催促の定型文。先頭の「@氏名」はinsert_mention_blocksがメンションとして保存する目印を兼ねる"""
    who = f"{sender_name}さんから" if sender_name else ""
    return (
        f"@{target_name} さん、{_elapsed_label(hours)}以上前に{who}メンションされた発言に、"
        "まだ返信もリアクションもありません。内容を確認して、返信か絵文字リアクションをお願いします。"
    )


async def _remind(row) -> None:
    pool = get_pool()
    body = reminder_body(row["target_name"], row["sender_name"], row["mention_reminder_hours"])
    async with pool.acquire() as conn, conn.transaction():
        reminder_id = await conn.fetchval(
            """INSERT INTO mention_reminders (message_id, user_id) VALUES ($1, $2)
               ON CONFLICT (message_id, user_id) DO NOTHING RETURNING id""",
            row["message_id"], row["target_user_id"],
        )
        if reminder_id is None:
            return
        reminder_message_id = await conn.fetchval(
            """INSERT INTO messages
                   (channel_id, thread_parent_id, sender_type, body, bot_display_name, bot_icon_url, is_reminder)
               VALUES ($1, $2, 'ai', $3, $4, $5, true) RETURNING id""",
            row["channel_id"], row["root_id"], body, row["persona_name"] or "Kogack AI", row["persona_icon_url"],
        )
        await insert_mention_blocks(
            conn, reminder_message_id,
            [MentionInput(target_user_id=str(row["target_user_id"]), display_name_snapshot=row["target_name"])],
            channel_id=row["channel_id"], body=body,
        )
        await conn.execute(
            "UPDATE mention_reminders SET reminder_message_id = $2 WHERE id = $1", reminder_id, reminder_message_id,
        )
        # スレッド返信を作ったので元発言のupdated_atも進め、本体タイムラインの「N件の返信」を
        # 他の参加者の画面にも反映させる（routers/messages.py post_replyと同じ理由）
        await conn.execute("UPDATE messages SET updated_at = now() WHERE id = $1", row["root_id"])
    background.spawn(push_sender.notify_mention_reminder(
        channel_id=row["channel_id"], user_id=row["target_user_id"], thread_parent_id=row["root_id"],
        sender_name=row["persona_name"] or "Kogack AI", body=body,
        url=f"/channels/{row['channel_id']}?thread={row['root_id']}",
    ))


async def dispatch_due_reminders() -> None:
    """期限を過ぎた未反応のメンションを探して催促する（scheduled_dispatcherの30秒ループから呼ぶ）"""
    rows = await get_pool().fetch(_DUE_SQL, STALE_AFTER, BATCH_LIMIT)
    for row in rows:
        await _remind(row)
