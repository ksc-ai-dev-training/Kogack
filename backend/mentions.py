# F-41 @メンション用の共通処理（詳細設計書 API設計4.3節、基本設計書5.22節「設計判断」）。
# T-07 message_blocksへblock_type='mention'として保存し、A-11（channels.py）・A-14（messages.py）・
# A-19（dms.py）から呼び出す。AIへのメンション検知（services/ai_agent.py起動）はチャンネルAI自体が
# チャンネル専用機能のためDMでは対象外のまま（基本設計書8章）。
import json
import re

from pydantic import BaseModel, Field

# コード表記（```コードブロック```・`コード（1行）`）。フロントの表示（MessageList.tsxの
# CODE_BLOCK_REGEX・INLINE_CODE_REGEX）と同じ規則。閉じていない```は投稿欄が送信時に自動で
# 閉じる（composerEditing.closeDanglingCodeFence）が、念のため文末までをコードとして扱う
_CODE_BLOCK_RE = re.compile(r"```[\s\S]*?(?:```|$)")
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")


def strip_code(body: str) -> str:
    """本文からコード表記の部分を取り除く（同じ長さの空白に置き換える）。コードの中に書かれた
    「@名前」「@channel」「@チャンネルAI名」はメンションとして扱わない（ユーザーからの明示的な要望
    「コード表記の中のものはメンション反応しないでほしい。コード表記の中の文章はそのままで」、
    2026-09-28）。保存・表示する本文自体は変えず、メンションの判定にだけこの結果を使う
    （insert_mention_blocks・ai_agent.detect_mention）"""
    body = _CODE_BLOCK_RE.sub(lambda m: " " * len(m.group(0)), body)
    return _INLINE_CODE_RE.sub(lambda m: " " * len(m.group(0)), body)


def _needle(m: "MentionInput") -> str:
    if m.kind in ("channel", "here"):
        return f"@{m.kind}"
    return f"@{m.display_name_snapshot}"

# F-41 @here（2026-09-11、ユーザーからの明示的な要望）。在席判定の有効期間（秒）。この秒数以内に
# users.last_seen_at（A-04ポーリングのたびに更新、routers/auth.py参照）が更新されている参加者を
# 「今アクティブ」とみなす。ユーザーとの合意により既定30秒（短すぎると本当に見ている人しか
# 拾えず、長すぎると既に離席した人にも届いてしまうトレードオフ）
HERE_ACTIVE_WINDOW_SECONDS = 30


class MentionInput(BaseModel):
    target_user_id: str
    display_name_snapshot: str = Field(min_length=1, max_length=100)
    # kind='channel' は @channel（チャンネル全員への通知）。kind='here' は @here（今アクティブな
    # 参加者への通知）。いずれもtarget_user_idは使わない。チャンネル発言でのみ有効（DMでは黙って無視）。
    kind: str = "user"


def _block_out(row) -> dict:
    payload = row["payload"]
    return {
        "block_type": row["block_type"],
        "payload": json.loads(payload) if isinstance(payload, str) else payload,
        "sort_order": row["sort_order"],
    }


async def insert_mention_blocks(
    conn, message_id: int, mentions: list[MentionInput], *, channel_id: int | None = None, dm_id: int | None = None,
    sender_user_id: int | None = None, body: str | None = None,
) -> list[dict]:
    """mentionsのうち当該チャンネル/DMの参加者であるものだけをT-07へ保存する
    （基本設計書5.22節「設計判断」: target_user_idが参加者であることをAPI側で検証）。
    参加者でないtarget_user_idは黙って除外する（メッセージ送信自体は失敗させない）。
    channel_id・dm_idはどちらか一方を指定する（messages.channel_id/dm_idと同じ排他関係）。
    sender_user_idは@here（在席判定）で送信者自身を対象から除くために使う。
    バグ修正（2026-09-04）: 従来はchannel_id専用でDMは対象外（呼び出し元がif文で分岐して
    空リストを返すだけ）だったが、ユーザーからの要望でDMでもメンションできるようにするため、
    direct_message_membersを見る経路を追加した。
    bodyを渡すと、本文のコード表記の外に「@名前」（@channel/@here）が無いメンションは保存しない
    （コードの中に書いただけのメンションで通知しない。strip_code参照）"""
    if body is not None:
        plain = strip_code(body)
        mentions = [m for m in mentions if _needle(m) in plain]
    if not mentions:
        return []
    blocks: list[dict] = []
    sort_order = 0

    # @channel（チャンネル全員への通知）。チャンネル発言のときだけ、payload {"kind":"channel"} を
    # 1件だけ保存する（複数回指定されても1件）。A-05のunread_mention_count側で、その値を持つ
    # ブロックがある発言をチャンネル参加者全員の「メンション未読」として数える。
    if channel_id is not None and any(m.kind == "channel" for m in mentions):
        row = await conn.fetchrow(
            """INSERT INTO message_blocks (message_id, block_type, payload, sort_order)
               VALUES ($1, 'mention', $2::jsonb, $3) RETURNING block_type, payload, sort_order""",
            message_id, json.dumps({"kind": "channel"}), sort_order,
        )
        blocks.append(_block_out(row))
        sort_order += 1

    # @here（今アクティブな参加者への通知）。送信時点でHERE_ACTIVE_WINDOW_SECONDS以内に
    # last_seen_atが更新されている参加者（送信者自身は除く）をその場でスナップショットし、
    # payload {"kind":"here","user_ids":[...]} を1件保存する。@channelと異なり対象を個々の
    # user_idで特定するため、A-05のunread_mention_countはpayload.user_idsに自分のidが
    # 含まれるかで判定する（jsonbの`?`演算子、配列要素の存在チェック）
    if channel_id is not None and any(m.kind == "here" for m in mentions):
        active_rows = await conn.fetch(
            """SELECT cm.user_id FROM channel_members cm
               JOIN users u ON u.id = cm.user_id
               WHERE cm.channel_id = $1 AND u.is_active = true
                 AND u.last_seen_at IS NOT NULL
                 AND u.last_seen_at > now() - make_interval(secs => $2)
                 AND cm.user_id IS DISTINCT FROM $3""",
            channel_id, HERE_ACTIVE_WINDOW_SECONDS, sender_user_id,
        )
        active_ids = [str(r["user_id"]) for r in active_rows]
        row = await conn.fetchrow(
            """INSERT INTO message_blocks (message_id, block_type, payload, sort_order)
               VALUES ($1, 'mention', $2::jsonb, $3) RETURNING block_type, payload, sort_order""",
            message_id, json.dumps({"kind": "here", "user_ids": active_ids}), sort_order,
        )
        blocks.append(_block_out(row))
        sort_order += 1

    user_mentions = [m for m in mentions if m.kind not in ("channel", "here")]
    candidate_ids = [int(m.target_user_id) for m in user_mentions if m.target_user_id.isdigit()]
    if not candidate_ids:
        return blocks
    if channel_id is not None:
        member_rows = await conn.fetch(
            "SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id = ANY($2::bigint[])",
            channel_id, candidate_ids,
        )
    elif dm_id is not None:
        member_rows = await conn.fetch(
            "SELECT user_id FROM direct_message_members WHERE dm_id = $1 AND user_id = ANY($2::bigint[])",
            dm_id, candidate_ids,
        )
    else:
        return blocks
    valid_ids = {r["user_id"] for r in member_rows}
    for m in user_mentions:
        if not m.target_user_id.isdigit() or int(m.target_user_id) not in valid_ids:
            continue
        payload = {"target_user_id": m.target_user_id, "display_name_snapshot": m.display_name_snapshot}
        row = await conn.fetchrow(
            """INSERT INTO message_blocks (message_id, block_type, payload, sort_order)
               VALUES ($1, 'mention', $2::jsonb, $3) RETURNING block_type, payload, sort_order""",
            message_id, json.dumps(payload), sort_order,
        )
        blocks.append(_block_out(row))
        sort_order += 1
    return blocks


def mention_summary(blocks: list[dict]) -> tuple[bool, set[str]]:
    """発言のmention系ブロックから「@channelが含まれるか」「個人宛て・@hereで具体的に
    特定された対象user_id集合」を取り出す。デスクトップ通知②（services/push_sender.py）が、
    参加者ごとに「この発言は自分宛てか」を判定するために使う（@channelは参加者全員が対象なので
    個別のuser_idを持たず、channel_wide=Trueとして別扱いにする）"""
    channel_wide = False
    ids: set[str] = set()
    for b in blocks:
        if b.get("block_type") != "mention":
            continue
        payload = b.get("payload") or {}
        kind = payload.get("kind")
        if kind == "channel":
            channel_wide = True
        elif kind == "here":
            ids.update(payload.get("user_ids") or [])
        elif payload.get("target_user_id"):
            ids.add(str(payload["target_user_id"]))
    return channel_wide, ids


async def fetch_blocks_grouped(pool, message_ids: list[int]) -> dict[int, list[dict]]:
    """複数メッセージ分のブロックを1クエリでまとめて取得する（A-10/A-13のN+1回避）"""
    if not message_ids:
        return {}
    rows = await pool.fetch(
        """SELECT message_id, block_type, payload, sort_order FROM message_blocks
           WHERE message_id = ANY($1::bigint[]) ORDER BY message_id, sort_order""",
        message_ids,
    )
    grouped: dict[int, list[dict]] = {}
    for r in rows:
        grouped.setdefault(r["message_id"], []).append(_block_out(r))
    return grouped
