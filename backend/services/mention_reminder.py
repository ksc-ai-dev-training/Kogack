# メンションの催促（ユーザーからの明示的な要望「メンションを受けたのに一定時間たっても返信も
# リアクションもしていないユーザーに対して、AIが自動的に返信を催促したりリマインドしたりする機能」、
# 2026-09-29。要件定義書上のF-xxに対応付けられていない新規機能）。
#
# 着手前にユーザーへ確認して決めた仕様:
# - 催促は元発言のスレッドへ、チャンネルAIのキャラクタ名・アイコンでAI発言として投稿する
#   （本体タイムラインは流さない）。メンションがスレッド返信の中にあった場合はそのスレッドへ
# - 「反応した」とみなすのは、メンションを含む発言への本人の絵文字リアクション、または同じスレッドへの
#   本人の（メンションより後の）返信
#   **2026-09-29追加（ユーザーとの合意）**: スレッドを使わずチャンネル本体で「了解です」と返事をした
#   場合にも催促が届いてしまう問題への対応として、次の2段階を足した。
#   (a) ルール: メンション後に、本人がメンションの送り主へ@を付けて発言していれば反応済み
#   (b) AI判定: 上記のどれにも当てはまらないが、メンション後に本人がこのチャンネル本体で発言している場合に
#       限り、元のメンション発言と本人のその後のチャンネル本体での発言（最大JUDGE_MAX_POSTS件。
#       別スレッドへの返信は含めない）をAIに渡し、返事に
#       なっているかを判定させる（judge_responded）。返事と判定したものは催促せず、T-30に
#       outcome='judged_responded'として記録して再判定しない。AIが使えない・答えが読み取れない場合は
#       従来どおり催促する側に倒す。判定のAI利用もT-13 ai_usage_logsに記録する
# - 待ち時間と有効/無効はチャンネルごと（T-08 channel_ai_settings.mention_reminder_*、S-06「反応モード」
#   タブ、A-77）。既定はオフ
# - 文面は定型文（催促の文面を作るのにLLMは呼ばない。上記(b)の判定でのみ呼ぶ）
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
import json
import traceback
from datetime import timedelta

import background
from database import get_pool
from mentions import MentionInput, insert_mention_blocks
from services import ai_client, push_sender

STALE_AFTER = timedelta(days=7)
BATCH_LIMIT = 50  # 1回のループで催促する最大件数（大量に溜まっていても1回の処理を長引かせない）
JUDGE_MAX_POSTS = 5  # AI判定に渡す、メンション後の本人の発言の最大件数（古い順）
# AI判定に使うモデルは、チャンネルのAIモデル設定（ai_model）に関係なく固定する。2026-09-29の精度評価
# （返事/別件が分かっている40例×2回）で、gpt-5-miniは97.5%だったのに対し、gpt-4.1-nano・gpt-5-nanoは
# いずれも81.2%で、「👍」「すみません！」「明日やります」のような短い返事の見落としや別件の誤判定が
# 多かった。判定は裏側の短い分類で費用もわずかなため、精度を優先する
JUDGE_MODEL = "gpt-5-mini"

# 催促すべき（発言, 対象者）の組。mention_blocksのpayloadのtarget_user_idは文字列で保存されている
# （mentions.insert_mention_blocks）ため、比較はtext同士で行う
_DUE_SQL = """
SELECT m.id AS message_id, m.channel_id, COALESCE(m.thread_parent_id, m.id) AS root_id,
       m.body AS mention_body, m.created_at AS mentioned_at,
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
  -- (a) メンション後に、本人が送り主へ@を付けて発言していれば反応済み（2026-09-29）。ただしその
  -- @付き発言は「それより前にある、同じ送り主から本人への一番新しいメンション」への返事とみなす
  -- （1件の@返事で、同じ送り主からの過去のメンションがまとめて反応済みにならないようにする。
  -- それより古いメンションは(b)のAI判定に回り、この@付き発言も判定材料として読まれる）
  AND NOT EXISTS (
    SELECT 1 FROM messages p
    JOIN message_blocks pb ON pb.message_id = p.id AND pb.block_type = 'mention'
    WHERE p.channel_id = m.channel_id AND p.sender_user_id = u.id AND p.deleted_at IS NULL
      AND p.created_at > m.created_at AND pb.payload->>'target_user_id' = m.sender_user_id::text
      AND NOT EXISTS (
        SELECT 1 FROM messages m2
        JOIN message_blocks b2 ON b2.message_id = m2.id AND b2.block_type = 'mention'
        WHERE m2.channel_id = m.channel_id AND m2.sender_user_id = m.sender_user_id
          AND m2.deleted_at IS NULL AND m2.created_at > m.created_at AND m2.created_at < p.created_at
          AND b2.payload->>'target_user_id' = u.id::text
      )
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


_JUDGE_SYSTEM = (
    "あなたは社内チャットの会話を読み、ある人がメンションに返事をしたかどうかを判定するアシスタントです。"
    "答えは必ず「はい」か「いいえ」の一語だけにしてください。"
)


def _judge_prompt(mention_body: str, sender_name: str, target_name: str, posts: list[str]) -> str:
    listed = "\n".join(f"{i}. {p}" for i, p in enumerate(posts, 1))
    return (
        f"【{sender_name}さんが{target_name}さんをメンションした発言】\n{mention_body}\n\n"
        f"【その後の{target_name}さんの発言（古い順）】\n{listed}\n\n"
        f"{target_name}さんのこれらの発言のどれかが、上のメンションへの返事になっていますか。"
        f"了解・回答・対応の報告・後で対応する旨・断りなど、このメンションの依頼や質問そのものを受け取って"
        f"反応したと分かるものは返事です。「了解です」などの言葉があっても、発言が別の話題（別の依頼や"
        f"別の件）を指している場合は、このメンションへの返事ではありません。メンションの内容と関係のない"
        f"発言しか無い場合も返事ではありません。"
        f"「はい」か「いいえ」の一語だけで答えてください。"
    )


async def judge_responded(
    mention_body: str, sender_name: str, target_name: str, posts: list[str], model: str,
) -> tuple[bool | None, dict, list[dict]]:
    """メンション後の本人の発言が、メンションへの返事になっているかをAIに判定させる（上記(b)）。
    戻り値は (返事ならTrue・違えばFalse・判定できなければNone, 使用トークン, 送信したmessages)。
    単体で呼べるようにしてあり、精度の確認にも使う"""
    messages = [
        {"role": "system", "content": _JUDGE_SYSTEM},
        {"role": "user", "content": _judge_prompt(mention_body, sender_name, target_name, posts)},
    ]
    extra = {"reasoning_effort": "minimal"} if ai_client.is_reasoning_model(model) else {}
    res = await ai_client.get_client().chat.completions.create(
        model=model, messages=messages, max_completion_tokens=300, **extra,
    )
    usage = {
        "prompt_tokens": res.usage.prompt_tokens if res.usage else 0,
        "completion_tokens": res.usage.completion_tokens if res.usage else 0,
    }
    answer = (res.choices[0].message.content or "").strip()
    if answer.startswith("はい"):
        return True, usage, messages
    if answer.startswith("いいえ"):
        return False, usage, messages
    return None, usage, messages


async def _responded_by_ai(row) -> bool:
    """メンション後に本人がこのチャンネルで発言していればAIに判定させ、返事と判定されたらTrue。
    発言が無い・AIが使えない・判定できない・エラーの場合はFalse（＝従来どおり催促する）"""
    if not ai_client.is_configured():
        return False
    pool = get_pool()
    posts = await pool.fetch(
        # 判定材料は本人のチャンネル本体での発言だけにする。別のスレッドへの返信は、その別の発言への
        # 反応であってこのメンションへの返事ではない（入れると「別スレッドでの『了解です』」を
        # このメンションへの返事と誤判定した）。同じスレッドへの返信は_DUE_SQLのルールで判定済み
        """SELECT body FROM messages
           WHERE channel_id = $1 AND sender_user_id = $2 AND deleted_at IS NULL AND created_at > $3
             AND thread_parent_id IS NULL
           ORDER BY created_at LIMIT $4""",
        row["channel_id"], row["target_user_id"], row["mentioned_at"], JUDGE_MAX_POSTS,
    )
    if not posts:
        return False
    model = JUDGE_MODEL
    try:
        verdict, usage, messages = await judge_responded(
            row["mention_body"], row["sender_name"] or "送り主", row["target_name"], [p["body"] for p in posts], model,
        )
    except Exception:
        traceback.print_exc()
        return False
    if usage["prompt_tokens"] or usage["completion_tokens"]:
        await pool.execute(
            """INSERT INTO ai_usage_logs
                   (channel_id, requested_by, model, input_tokens, output_tokens, estimated_cost_yen,
                    message_id, request_payload)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)""",
            row["channel_id"], row["target_user_id"], model, usage["prompt_tokens"], usage["completion_tokens"],
            ai_client.estimate_cost_yen(model, usage["prompt_tokens"], usage["completion_tokens"]),
            row["message_id"], json.dumps(messages, ensure_ascii=False),
        )
    return verdict is True


async def dispatch_due_reminders() -> None:
    """期限を過ぎた未反応のメンションを探して催促する（scheduled_dispatcherの30秒ループから呼ぶ）"""
    pool = get_pool()
    rows = await pool.fetch(_DUE_SQL, STALE_AFTER, BATCH_LIMIT)
    for row in rows:
        if await _responded_by_ai(row):
            # 返事済みと判定: 催促せず、再判定しないよう記録だけ残す
            await pool.execute(
                """INSERT INTO mention_reminders (message_id, user_id, outcome) VALUES ($1, $2, 'judged_responded')
                   ON CONFLICT (message_id, user_id) DO NOTHING""",
                row["message_id"], row["target_user_id"],
            )
            continue
        await _remind(row)
