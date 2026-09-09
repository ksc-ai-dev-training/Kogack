# 層2ドキュメントQ&A（Slice 3、2026-09-09）の検索本体。ai_agent.pyのsearch_documents
# ツールから呼ばれる。
#
# 権限について: 検索範囲は「このチャンネルの参照範囲（channel_doc_folders）に設定されている
# フォルダ」に限定する。限定公開フォルダについては、Slice 2b（閲覧権限モデル）で
# 「そのフォルダが非公開チャンネルの参照範囲にある限り、参加者全員が閲覧権限を持つ」という
# 不変条件を(4)(5)(6)(7)(8)の一連の制約で維持しているため、ここで質問者本人の権限を
# 改めて確認する必要はない（チャンネルに参加できている時点で、参照範囲内の全フォルダに
# 対する閲覧権限が保証されている）。
from database import get_pool
from services import ai_client

TOP_K = 5
# コサイン距離（0=完全一致、大きいほど無関係）の足切り。実測で無関係な質問（例:
# 「富士山の標高は？」を社内規定文書に対して検索）は0.83〜0.90、実際に関連する質問は
# 0.47〜0.56だったため、その中間の0.7を閾値とした。これが無いと、TOP_Kが常に何かしら
# 返してしまうため、無関係な質問でも文書がヒットしたかのようにAIへ渡ってしまい、
# (1) AIが無関係な内容を根拠に一般知識で回答してしまう、(2) 実際には使っていない文書が
# 引用として表示される、という2つの不具合を実機検証で確認し、これを避けるために追加した。
DISTANCE_THRESHOLD = 0.7


async def channel_has_indexed_documents(channel_id: int) -> bool:
    """このチャンネルの参照範囲に、索引化済み（index_status='ready'）の文書が1件でもあるか。
    無ければsearch_documentsツール自体をAIに持たせない（ツールを提示しても検索対象が無いのは
    利用者にとって紛らわしいだけのため）。"""
    return bool(
        await get_pool().fetchval(
            """SELECT EXISTS(
                   SELECT 1 FROM channel_doc_folders cdf
                   JOIN doc_folders f ON f.id = cdf.folder_id
                   WHERE cdf.channel_id = $1 AND f.index_status = 'ready'
               )""",
            channel_id,
        )
    )


async def search(channel_id: int, query: str) -> list[dict]:
    """queryに関連するチャンクを、このチャンネルの参照範囲内から類似度上位TOP_K件返す。
    [{folder_id, folder_name, content, distance}, ...]（distanceは小さいほど類似）"""
    pool = get_pool()
    folder_rows = await pool.fetch(
        """SELECT f.id FROM channel_doc_folders cdf
           JOIN doc_folders f ON f.id = cdf.folder_id
           WHERE cdf.channel_id = $1 AND f.index_status = 'ready'""",
        channel_id,
    )
    folder_ids = [r["id"] for r in folder_rows]
    if not folder_ids:
        return []

    vectors, _tokens = await ai_client.embed_texts([query])
    query_vec = str(vectors[0])

    rows = await pool.fetch(
        """SELECT c.folder_id, f.drive_folder_name AS folder_name, c.content,
                  c.embedding <=> $1 AS distance
           FROM doc_chunks c
           JOIN doc_folders f ON f.id = c.folder_id
           WHERE c.folder_id = ANY($2::bigint[])
             AND c.embedding <=> $1 < $4
           ORDER BY distance
           LIMIT $3""",
        query_vec, folder_ids, TOP_K, DISTANCE_THRESHOLD,
    )
    return [dict(r) for r in rows]
