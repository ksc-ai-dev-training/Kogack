# F-41 @メンション用の共通処理（詳細設計書 API設計4.3節、基本設計書5.22節「設計判断」）。
# T-07 message_blocksへblock_type='mention'として保存し、A-11（channels.py）・A-14（messages.py）の
# 両方から呼び出す。AIへのメンション検知（services/ai_agent.py起動）・自動応答トリガー判定は
# AIサポート未実装のためこのスライスの対象外（人間へのメンション参照の保存・表示のみ）。
import json

from pydantic import BaseModel, Field


class MentionInput(BaseModel):
    target_user_id: str
    display_name_snapshot: str = Field(min_length=1, max_length=100)


def _block_out(row) -> dict:
    payload = row["payload"]
    return {
        "block_type": row["block_type"],
        "payload": json.loads(payload) if isinstance(payload, str) else payload,
        "sort_order": row["sort_order"],
    }


async def insert_mention_blocks(conn, message_id: int, channel_id: int, mentions: list[MentionInput]) -> list[dict]:
    """mentionsのうち当該チャンネルの参加者であるものだけをT-07へ保存する
    （基本設計書5.22節「設計判断」: target_user_idが当該チャンネルの参加者であることをAPI側で検証）。
    参加者でないtarget_user_idは黙って除外する（メッセージ送信自体は失敗させない）。"""
    if not mentions:
        return []
    candidate_ids = [int(m.target_user_id) for m in mentions if m.target_user_id.isdigit()]
    if not candidate_ids:
        return []
    valid_ids = {
        r["user_id"]
        for r in await conn.fetch(
            "SELECT user_id FROM channel_members WHERE channel_id = $1 AND user_id = ANY($2::bigint[])",
            channel_id, candidate_ids,
        )
    }
    blocks: list[dict] = []
    sort_order = 0
    for m in mentions:
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
