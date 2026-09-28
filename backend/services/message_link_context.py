# 発言リンクの展開（ユーザーからの明示的な要望「文面のコピーだけでなく、リンクもはれるように
# してほしい。Slack内で過去のスレッドを張り付けて参照させる際に、その前後も見てもらいたいことも
# あるため、同様のことができると嬉しい」）。S-03/S-04の右クリックメニュー「リンクをコピー」で
# 作られる発言リンク（`/channels/{id}?highlight={発言id}` または `/dms/{id}?...`、スレッド返信なら
# `thread=`も付く。S-05横断検索のハイライトジャンプと同じURL形式）が会話に貼られていたら、
# リンク先の発言とその前後の会話・スレッドをai_agent._generate_and_postのシステムプロンプトへ
# 添える。
#
# 閲覧範囲（非公開の存在は非参加者に一切露出させない、という非公開チャンネルF-34の原則に揃える）:
# AIの回答はこのチャンネルの参加者全員に見えるため、「リンクを貼った本人が見られるか」ではなく
# 「このチャンネルの誰に見せてもよいか」で判定する。展開するのは同じチャンネル内の発言と公開
# チャンネルの発言のみで、非公開チャンネル・DMの発言は中身を一切渡さない（参照できない旨だけ
# 伝え、AIが「中身を推測して作文する」ことを防ぐ）。
#
# ホスト名は照合しない（ローカル開発・ステージング・本番でオリジンが異なるため）。発言IDで
# 引き直し上記の閲覧範囲で判定するので、無関係なサイトのURLがたまたま同じ形でも害は無い。
import re
from zoneinfo import ZoneInfo

from database import get_pool

JST = ZoneInfo("Asia/Tokyo")
LINK_RE = re.compile(r"https?://[^\s/()<>\[\]]+/(?:channels|dms)/\d+\?[^\s()<>\[\]]*?\bhighlight=(\d+)")
MAX_LINKS = 3  # 1回の応答で展開するリンク数の上限（トークン消費の際限ない増大を防ぐ）
CONTEXT_BEFORE = 5  # リンク先の前後に添えるチャンネル本体の発言数
CONTEXT_AFTER = 5
MAX_THREAD_MESSAGES = 20  # スレッドを添える場合の上限（リンク先の返信を中心に前後を切り出す）


def extract_linked_message_ids(bodies: list[str]) -> list[int]:
    """bodies（新しい発言から順）に含まれる発言リンクの発言IDを、重複を除きMAX_LINKS件まで返す"""
    ids: list[int] = []
    for body in bodies:
        for m in LINK_RE.finditer(body or ""):
            mid = int(m.group(1))
            if mid not in ids:
                ids.append(mid)
            if len(ids) >= MAX_LINKS:
                return ids
    return ids


_SELECT = """SELECT m.id, m.sender_type, m.bot_display_name, m.body, m.created_at, u.name AS sender_name
             FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id"""


def _format(rows, target_id: int) -> list[str]:
    lines = []
    for r in rows:
        if r["sender_type"] == "human":
            name = r["sender_name"] or "利用者"
        elif r["sender_type"] == "ai":
            name = f"{r['bot_display_name'] or 'AI'}（AI）"
        else:
            name = r["bot_display_name"] or "BOT"
        mark = "★リンク先 " if r["id"] == target_id else ""
        ts = r["created_at"].astimezone(JST).strftime("%Y-%m-%d %H:%M")
        lines.append(f"{mark}[{ts}] {name}: {r['body']}")
    return lines


async def _thread_rows(pool, root_id: int, target_id: int):
    rows = await pool.fetch(
        f"""{_SELECT}
            WHERE (m.id = $1 OR m.thread_parent_id = $1) AND m.deleted_at IS NULL AND m.generation_status IS NULL
            ORDER BY m.created_at""",
        root_id,
    )
    if len(rows) <= MAX_THREAD_MESSAGES:
        return rows
    # 長いスレッドは元発言を必ず残し、リンク先の返信を中心に切り出す
    idx = next((i for i, r in enumerate(rows) if r["id"] == target_id), 0)
    start = max(1, min(idx - MAX_THREAD_MESSAGES // 2, len(rows) - (MAX_THREAD_MESSAGES - 1)))
    return [rows[0], *rows[start:start + MAX_THREAD_MESSAGES - 1]]


async def _describe(pool, current_channel_id: int, message_id: int) -> str:
    msg = await pool.fetchrow(
        """SELECT m.id, m.channel_id, m.dm_id, m.thread_parent_id, m.created_at, m.deleted_at,
                  c.name AS channel_name, c.is_public
           FROM messages m LEFT JOIN channels c ON c.id = m.channel_id
           WHERE m.id = $1""",
        message_id,
    )
    if msg is None or msg["deleted_at"] is not None:
        return f"## 発言リンク（ID {message_id}）\n（リンク先の発言は削除されたか存在しません）"
    if msg["channel_id"] is None or (msg["channel_id"] != current_channel_id and not msg["is_public"]):
        return (
            f"## 発言リンク（ID {message_id}）\n"
            "（参照不可: 非公開チャンネルまたはDMの発言）"
        )

    place = "このチャンネル" if msg["channel_id"] == current_channel_id else f"#{msg['channel_name']}"
    parts = [f"## 発言リンク（{place}の発言）"]
    if msg["thread_parent_id"] is not None:
        rows = await _thread_rows(pool, msg["thread_parent_id"], message_id)
        parts.append("### リンク先を含むスレッド（先頭が元発言）")
        parts += _format(rows, message_id)
        return "\n".join(parts)

    before = await pool.fetch(
        f"""{_SELECT}
            WHERE m.channel_id = $1 AND m.thread_parent_id IS NULL AND m.deleted_at IS NULL
              AND m.generation_status IS NULL AND (m.created_at, m.id) < ($2, $3)
            ORDER BY m.created_at DESC, m.id DESC LIMIT $4""",
        msg["channel_id"], msg["created_at"], message_id, CONTEXT_BEFORE,
    )
    after = await pool.fetch(
        f"""{_SELECT}
            WHERE m.channel_id = $1 AND m.thread_parent_id IS NULL AND m.deleted_at IS NULL
              AND m.generation_status IS NULL AND (m.created_at, m.id) >= ($2, $3)
            ORDER BY m.created_at, m.id LIMIT $4""",
        msg["channel_id"], msg["created_at"], message_id, CONTEXT_AFTER + 1,
    )
    parts.append("### リンク先の前後の会話")
    parts += _format([*reversed(before), *after], message_id)
    thread = await _thread_rows(pool, message_id, message_id)
    if len(thread) > 1:
        parts.append("### リンク先の発言についたスレッド（先頭が元発言）")
        parts += _format(thread, message_id)
    return "\n".join(parts)


async def build_section(current_channel_id: int, bodies: list[str]) -> str:
    """bodies（新しい発言から順）に貼られた発言リンクを展開したシステムプロンプト用の節を返す。
    リンクが無ければ空文字"""
    ids = extract_linked_message_ids(bodies)
    if not ids:
        return ""
    pool = get_pool()
    sections = [await _describe(pool, current_channel_id, mid) for mid in ids]
    return (
        "# 会話中に貼られた発言リンクの内容\n"
        "利用者が貼ったKogackの発言リンクの中身と、その前後の会話です（★がリンク先の発言）。"
        "リンクについて質問されたら、推測ではなくこの内容を根拠に答えること。"
        "ただしこの一覧自体を転記・列挙せず、質問に必要な点だけを自分の言葉でまとめて答えること。"
        "「参照不可」のリンクは中身を推測せず、非公開チャンネルまたはDMの発言のためこのチャンネルでは"
        "内容を確認できない、とだけ短く伝えること。\n\n"
        + "\n\n".join(sections)
    )
