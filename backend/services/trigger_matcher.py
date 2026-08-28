# F-38 自動応答トリガー（基本設計書5.19節）。F-35/F-36の時刻ベースのディスパッチャとは異なり、
# A-11（channels.pyのpost_message）内で同期的に判定するイベント駆動方式（基本設計書6.2節「設計判断」。
# 判定処理が文字列の部分一致とDB1件挿入のみで完結し、外部API呼び出しを伴わないため）。
#
# このスライスの対象はA-11（チャンネル本体の投稿）のみで、スレッド返信（A-14）は対象外とする
# （F-41のAIメンショントリガーと同じスコープの絞り方。A-11はthread_parent_idを持たないため、
# 生成されるBOT発言は常にチャンネル本体への新規投稿になる）。
from database import get_pool


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
        await pool.execute(
            """INSERT INTO messages
                   (channel_id, sender_type, body, bot_display_name, bot_icon, bot_icon_url, trigger_rule_id)
               VALUES ($1, 'bot', $2, $3, $4, $5, $6)""",
            channel_id, rule["action_body"], rule["bot_display_name"], rule["bot_icon"],
            rule["bot_icon_url"], rule["id"],
        )
