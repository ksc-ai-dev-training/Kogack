# F-38 自動応答トリガー（基本設計書5.19節）。F-35/F-36の時刻ベースのディスパッチャとは異なり、
# A-11（channels.pyのpost_message）内で同期的に判定するイベント駆動方式（基本設計書6.2節「設計判断」。
# 判定処理が文字列の部分一致とDB1件挿入のみで完結し、外部API呼び出しを伴わないため）。
#
# このスライスの対象はA-11（チャンネル本体の投稿）のみで、スレッド返信（A-14）は対象外とする
# （F-41のAIメンショントリガーと同じスコープの絞り方。A-11はthread_parent_idを持たないため、
# 生成されるBOT発言は常にチャンネル本体への新規投稿になる）。
#
# @メンションの構造化（T-07）は2026-09-15にrecurring_posts（F-36）と同じ考え方で追加した:
# trigger_rules.mentionsをinsert_mention_blocksへ渡し、実際に発言化するこのタイミングで
# 参加者チェック込みでT-07へ反映する（routers/trigger_rules.pyのコメント参照）。BOT発言
# （F-36/F-38/F-43共通の枠組み）はsender_type='human'の投稿のみをAIエージェント起動の対象とする
# 一貫原則を踏まえ、**チャンネルAIへの@メンション応答（ai_agent.maybe_trigger）のみ、
# 2026-09-15にユーザーからの明示的な要望「トリガーにも反応するようにしてください」を受けて
# F-36と同じ例外にした**（force_mention=Trueで呼ぶ。詳細はai_agent.maybe_triggerのdocstring参照。
# トリガーの書き込み経路はS-06管理画面のみで、AIの応答自体が新たなトリガー発火を生むことは
# 無いため、この例外が連鎖起動を生む経路にはならない）。F-38自動応答トリガー自体（このファイル、
# キーワード/絵文字の部分一致判定）は引き続きsender_type='human'の投稿のみを対象とし、BOT発言が
# 別のトリガーを呼び出すことは無い（無限ループ防止、変更なし）。
import json

from database import get_pool
from mentions import MentionInput, insert_mention_blocks
from services import ai_agent


def _matches(rule_row, body: str) -> bool:
    if rule_row["trigger_type"] == "keyword":
        return rule_row["trigger_value"].lower() in body.lower()
    # emoji: 文字そのものの包含判定（大文字小文字の概念が無いため単純な部分一致でよい）
    return rule_row["trigger_value"] in body


async def maybe_trigger(channel_id: int, body: str) -> None:
    """一致したルールごとに、T-05へsender_type='bot'の発言を1件作成する（同一メッセージが複数
    ルールに一致した場合は一致したルールすべてがそれぞれ投稿する）。BOT発言自体はここでは
    生成せず判定対象にもしない（sender_type='human'の発言のみを判定対象とするA-11からの
    呼び出しである前提のため、無限ループにはならない。F-36と同じ無限ループ防止の考え方）。"""
    pool = get_pool()
    rules = await pool.fetch(
        "SELECT * FROM trigger_rules WHERE channel_id = $1 AND is_active = true", channel_id
    )
    for rule in rules:
        if not _matches(rule, body):
            continue
        async with pool.acquire() as conn, conn.transaction():
            message_row = await conn.fetchrow(
                """INSERT INTO messages
                       (channel_id, sender_type, body, bot_display_name, bot_icon, bot_icon_url, trigger_rule_id)
                   VALUES ($1, 'bot', $2, $3, $4, $5, $6) RETURNING id""",
                channel_id, rule["action_body"], rule["bot_display_name"], rule["bot_icon"],
                rule["bot_icon_url"], rule["id"],
            )
            raw_mentions = rule["mentions"]
            mentions_data = json.loads(raw_mentions) if isinstance(raw_mentions, str) else raw_mentions
            if mentions_data:
                await insert_mention_blocks(
                    conn, message_row["id"], [MentionInput(**m) for m in mentions_data],
                    channel_id=channel_id,
                )
        # トランザクションのコミット後に呼ぶ（_dispatch_recurring_postsと同じ順序。ai_agent側は
        # 自身のasyncio.create_taskでAI応答生成を非同期起動するfire-and-forgetのため、この呼び出し
        # 自体はすぐ返り判定ループをブロックしない）
        await ai_agent.maybe_trigger(channel_id, rule["action_body"], rule["created_by"], force_mention=True)
