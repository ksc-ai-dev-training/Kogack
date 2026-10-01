# 本体タイムラインの差分ポーリング（A-10/A-18のsince）で、削除された発言を他の参加者の画面へ
# 伝えるための共通処理（routers/channels.py・dms.pyの両方から使う。attachments.py・reactions.py等と
# 同じ「ルーター横断の共通処理はトップレベルのモジュールに置く」構成）。
# 従来は差分ポーリングが削除を検知できず、削除した本人の画面からしか消えなかった（2026-09-28、
# ユーザーからの要望「スレッドの元発言が削除されたらスレッド画面を閉じてほしい」の対応中に発覚）。

from datetime import datetime, timedelta

from fastapi import HTTPException

# 差分ポーリングの取得開始をクライアントのsinceより少し前へ巻き戻す幅（2026-09-29バグ修正）。
# updated_atの既定値・UPDATE時のnow()は「トランザクション開始時刻」でありコミット時刻ではない。
# そのため、先に始まった投稿のトランザクション（メンション・添付の書き込み中）より後に始まった
# 別の更新（リアクション等）が先にコミットされ、その間にポーリングしたクライアントのsinceが
# 投稿より後の時刻まで進むと、後からコミットされた投稿は「updated_at > since」を二度と満たさず、
# 再読み込みするまで表示されなかった。巻き戻した分の重複はフロント（useMessages）がid一致で
# 上書き・deleted_idsの再受信も冪等なので害は無い
SINCE_OVERLAP = timedelta(seconds=5)


def parse_since(since: str) -> datetime:
    """A-10/A-18のsince文字列を、SINCE_OVERLAPだけ巻き戻した検索開始時刻に変換する"""
    try:
        return datetime.fromisoformat(since.replace("Z", "+00:00")) - SINCE_OVERLAP
    except ValueError:
        raise HTTPException(422, detail="sinceの形式が不正です") from None


async def deleted_since(pool, scope_column: str, scope_id: int, since_dt) -> list:
    """since以降に削除された本体タイムラインの発言（id・updated_at）。差分ポーリングは削除済みの行を
    itemsに含めないため、別枠のdeleted_idsとして返し、フロント（useMessages）が一覧から取り除く
    （A-12削除はupdated_atも進める、routers/messages.py delete_message参照）"""
    return await pool.fetch(
        f"""SELECT id, updated_at FROM messages
            WHERE {scope_column} = $1 AND deleted_at IS NOT NULL AND thread_parent_id IS NULL
              AND updated_at > $2""",
        scope_id, since_dt,
    )


def since_extras(rows, deleted_rows) -> dict:
    """差分ポーリングの応答に付け足す項目。next_sinceは削除分も含めた最大のupdated_at
    （削除だけが起きたポーリングでitemsが空でも、カーソルを進めて同じ削除を繰り返し返さない）"""
    stamps = [r["updated_at"] for r in rows] + [r["updated_at"] for r in deleted_rows]
    return {
        "deleted_ids": [str(r["id"]) for r in deleted_rows],
        "next_since": max(stamps).isoformat() if stamps else None,
    }
