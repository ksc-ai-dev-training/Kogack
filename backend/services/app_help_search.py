# 操作マニュアルの内容検索（ai_agent.pyのsearch_app_manualツールから呼ばれる）。
# services/doc_search.pyと同じコサイン距離検索だが、channel_doc_folders等のper-channel
# スコープを一切見ない（全チャンネル共通で常に検索対象。services/app_help_indexer.py参照）。
from database import get_pool
from services import ai_client

TOP_K = 4
# doc_search.pyのDISTANCE_THRESHOLD（0.7、実測に基づく足切り。無関係な質問は0.83〜0.90、
# 関連する質問は0.47〜0.56だった）と同じ考え方・同じ値をそのまま踏襲する。マニュアルは
# 語彙の幅が業務文書よりさらに狭く、この閾値で十分機能すると判断した。
DISTANCE_THRESHOLD = 0.7


async def search(query: str) -> list[dict]:
    """queryに関連するマニュアルのチャンクを類似度上位TOP_K件返す。
    [{content, distance}, ...]（distanceは小さいほど類似）。索引が空（OPENAI_API_KEY未設定で
    索引化されていない等）の場合は空リストを返す（doc_search.searchと同じ挙動、呼び出し元は
    空を「見つからない」として扱う）。"""
    pool = get_pool()
    vectors, _tokens = await ai_client.embed_texts([query])
    query_vec = str(vectors[0])
    rows = await pool.fetch(
        """SELECT content, embedding <=> $1 AS distance
           FROM app_help_chunks
           WHERE embedding <=> $1 < $3
           ORDER BY distance
           LIMIT $2""",
        query_vec, TOP_K, DISTANCE_THRESHOLD,
    )
    return [dict(r) for r in rows]
