# F-07 ファイル共有用の共通処理（詳細設計書 API設計4.5節）。T-06 message_attachmentsへの保存・取得を
# A-11（channels.py）・A-14（messages.py）・A-19（dms.py）の3箇所から共通で呼び出す。
# アップロード自体（A-21、routers/attachments.py）はファイルの実体をディスクへ保存するのみでDB行は
# 作らない（T-06.message_idはNOT NULLで、投稿前は確定したmessage_idが無いため）。クライアントは
# A-21のレスポンス（file_name/byte_size/storage_path）を保持しておき、実際の投稿時にこのモジュールが
# message_attachmentsへ書き込む（T-07 message_blocksのF-41メンションと同じ「発言確定後に紐づける」考え方）。
from pydantic import BaseModel, Field


class AttachmentInput(BaseModel):
    file_name: str = Field(min_length=1, max_length=255)
    byte_size: int = Field(gt=0)
    storage_path: str = Field(min_length=1)


def _out(row) -> dict:
    return {"id": str(row["id"]), "file_name": row["file_name"], "byte_size": row["byte_size"]}


async def insert_attachments(
    conn, message_id: int, uploaded_by: int, attachments: list[AttachmentInput],
) -> list[dict]:
    """A-21で保存済みのファイルを、確定したmessage_idに紐づけてT-06へ書き込む。
    A-21を経由していない（=クライアントが自由に組み立てた）storage_pathが渡されても、
    実ファイルが存在しない限りA-22でのダウンロード時に404になるだけで実害はない。"""
    results = []
    for a in attachments:
        row = await conn.fetchrow(
            """INSERT INTO message_attachments (message_id, file_name, byte_size, storage_path, uploaded_by)
               VALUES ($1, $2, $3, $4, $5) RETURNING id, file_name, byte_size""",
            message_id, a.file_name, a.byte_size, a.storage_path, uploaded_by,
        )
        results.append(_out(row))
    return results


async def fetch_attachments_grouped(pool, message_ids: list[int]) -> dict[int, list[dict]]:
    """複数メッセージ分の添付をまとめて取得する（mentions.fetch_blocks_groupedと同じくA-10/A-13/A-18のN+1回避）"""
    if not message_ids:
        return {}
    rows = await pool.fetch(
        """SELECT message_id, id, file_name, byte_size FROM message_attachments
           WHERE message_id = ANY($1::bigint[]) ORDER BY message_id, id""",
        message_ids,
    )
    grouped: dict[int, list[dict]] = {}
    for r in rows:
        grouped.setdefault(r["message_id"], []).append(_out(r))
    return grouped
