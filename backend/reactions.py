# F-xx（要件定義書上のF-xxに対応付けられていない新規機能）絵文字リアクション用の共通処理
# （T-26 message_reactions）。ユーザーからの明示的な要望「Slackのように発言一つ一つに対して
# 絵文字でリアクションできるようにしたい」により追加。attachments.py・mentions.pyと同じ構成
# （routers/channels.py・dms.py・messages.pyの3箇所から共通で呼び出すgrouped fetch）。


def _out(emoji: str, count: int, reacted_by_me: bool, user_names: list[str]) -> dict:
    return {"emoji": emoji, "count": count, "reacted_by_me": reacted_by_me, "user_names": user_names}


async def fetch_reactions_grouped(pool, message_ids: list[int], current_user_id: int) -> dict[int, list[dict]]:
    """複数メッセージ分のリアクションをまとめて取得する（mentions.fetch_blocks_grouped等と同じく
    A-10/A-13/A-18のN+1回避）。絵文字ごとに件数・自分が付けているか・付けた人の氏名一覧
    （フロントのツールチップ用、A-67等と同じくサーバー側で現在の表示名まで解決してから返す）
    にまとめる。emoji単位の順序は最初に誰かが付けた順（created_at昇順）を維持する。"""
    if not message_ids:
        return {}
    rows = await pool.fetch(
        """SELECT r.message_id, r.emoji, r.user_id, u.name AS user_name
           FROM message_reactions r JOIN users u ON u.id = r.user_id
           WHERE r.message_id = ANY($1::bigint[])
           ORDER BY r.message_id, r.created_at""",
        message_ids,
    )
    # message_id -> emoji -> 集計用の作業用dict（Python 3.7+の辞書は挿入順を保持するため、
    # 最初に登場した絵文字の順序＝最初に誰かが付けた順、がそのままemoji一覧の並び順になる）
    grouped: dict[int, dict[str, dict]] = {}
    for r in rows:
        by_emoji = grouped.setdefault(r["message_id"], {})
        entry = by_emoji.setdefault(r["emoji"], {"count": 0, "reacted_by_me": False, "user_names": []})
        entry["count"] += 1
        entry["user_names"].append(r["user_name"])
        if r["user_id"] == current_user_id:
            entry["reacted_by_me"] = True
    return {
        message_id: [_out(emoji, e["count"], e["reacted_by_me"], e["user_names"]) for emoji, e in by_emoji.items()]
        for message_id, by_emoji in grouped.items()
    }


async def toggle_reaction(pool, message_id: int, user_id: int, emoji: str) -> bool:
    """既に自分がこの発言にこの絵文字でリアクション済みなら削除、無ければ追加する（A-75）。
    戻り値は追加した場合True・削除した場合False。同じトランザクションでmessages.updated_atも
    更新し、他の参加者の3秒間隔ポーリング（sinceによる差分取得）でこの発言の変化が拾われる
    ようにする（2026-09-04にAI応答の表示反映で踏んだのと同じ「本文以外の更新でもupdated_atを
    進めないとポーリングで検知されない」という教訓を踏襲）。"""
    async with pool.acquire() as conn, conn.transaction():
        deleted_id = await conn.fetchval(
            """DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3
               RETURNING id""",
            message_id, user_id, emoji,
        )
        if deleted_id is None:
            await conn.execute(
                "INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)",
                message_id, user_id, emoji,
            )
            added = True
        else:
            added = False
        await conn.execute("UPDATE messages SET updated_at = now() WHERE id = $1", message_id)
    return added
