# 層2ドキュメントQ&A（Slice 3、2026-09-09）の検索本体。ai_agent.pyのsearch_documents
# ツールから呼ばれる。
#
# 権限について: 検索範囲は「このチャンネルの参照範囲（channel_doc_folders）に設定されている
# フォルダ」に限定する。限定公開フォルダについては、Slice 2b（閲覧権限モデル）で
# 「そのフォルダが非公開チャンネルの参照範囲にある限り、参加者全員が閲覧権限を持つ」という
# 不変条件を(4)(5)(6)(7)(8)の一連の制約で維持しているため、ここで質問者本人の権限を
# 改めて確認する必要はない（チャンネルに参加できている時点で、参照範囲内の全フォルダに
# 対する閲覧権限が保証されている）。
import unicodedata

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


# ファイル名指定の質問への対応（2026-10-01、ユーザーからの報告「サブフォルダ内の文書について
# 『son-folder/document file.docx には何が書いてある？』と聞いたら、そんなファイルは無いと返された」）。
# ベクトル検索は文書の本文の意味だけを比べ、ファイル名は一切検索対象にしていないため、ファイル名だけを
# 手がかりにした質問は本文と意味が離れてDISTANCE_THRESHOLDで足切りされていた（実測0.77〜0.85。
# 「2022 Houston Astros.docx」のように名前と本文の意味が近い文書だけが偶然ヒットしていた）。
# そこで、検索語句にこのチャンネルの参照範囲内のファイル名（フォルダ部分・拡張子の有無を問わない）が
# 含まれていれば、ベクトル検索より前にそのファイルの先頭チャンクを結果へ含める。
# 名前一致したファイルから返す先頭チャンク数と、1回の検索で名前一致として扱うファイル数の上限
NAME_HIT_CHUNKS = 3
NAME_HIT_MAX_FILES = 3
# 「a.docx」の「a」のような短すぎる名前は、無関係な質問の文字列にも偶然含まれてしまうため名前一致に使わない
NAME_MATCH_MIN_LEN = 3


def _normalize(text: str) -> str:
    """全角・半角、大文字・小文字、空白の有無の違いを吸収して比較するための正規化"""
    return "".join(unicodedata.normalize("NFKC", text).lower().split())


def _name_candidates(file_name: str) -> set[str]:
    """ファイル名の照合候補: そのままのパス・フォルダ部分を除いた名前・さらに拡張子を除いた名前"""
    base = file_name.rsplit("/", 1)[-1]
    stem = base.rsplit(".", 1)[0] if "." in base else base
    return {c for c in (_normalize(file_name), _normalize(base), _normalize(stem)) if len(c) >= NAME_MATCH_MIN_LEN}


async def _indexed_files(channel_id: int) -> list[dict]:
    return [
        dict(r)
        for r in await get_pool().fetch(
            """SELECT f.id, f.drive_folder_name AS name FROM channel_doc_folders cdf
               JOIN doc_folders f ON f.id = cdf.folder_id
               WHERE cdf.channel_id = $1 AND f.index_status = 'ready'
               ORDER BY f.drive_folder_name""",
            channel_id,
        )
    ]


async def list_indexed_document_names(channel_id: int) -> list[str]:
    """このチャンネルの参照範囲にある索引化済み（index_status='ready'）文書のファイル名一覧。
    空ならsearch_documentsツール自体をAIに持たせない（ツールを提示しても検索対象が無いのは
    利用者にとって紛らわしいだけのため）。空でなければ一覧をAIへの指示に含め、AIが実在する
    文書を「存在しない」と答えないようにする（2026-10-01、上記のファイル名指定の質問への対応）"""
    return [r["name"] for r in await _indexed_files(channel_id)]


def _match_files_by_name(query: str, files: list[dict]) -> list[dict]:
    q = _normalize(query)
    # 長い候補（フォルダ込みのパス等）で一致したものほど確からしいので、一致した候補の長さ順に並べる
    scored = []
    for f in files:
        hits = [c for c in _name_candidates(f["name"]) if c in q]
        if hits:
            scored.append((max(len(c) for c in hits), f))
    scored.sort(key=lambda x: -x[0])
    return [f for _, f in scored[:NAME_HIT_MAX_FILES]]


async def search(channel_id: int, query: str) -> list[dict]:
    """queryに関連するチャンクを、このチャンネルの参照範囲内から返す。
    [{folder_id, folder_name, content, distance}, ...]（distanceは小さいほど類似）。
    queryにファイル名が含まれていれば、そのファイルの先頭チャンクを先頭に置き（distance=0扱い）、
    続けてベクトル検索の類似度上位TOP_K件（重複は除く）を返す。"""
    pool = get_pool()
    files = await _indexed_files(channel_id)
    folder_ids = [f["id"] for f in files]
    if not folder_ids:
        return []

    results: list[dict] = []
    seen: set[tuple[int, int]] = set()
    for f in _match_files_by_name(query, files):
        for r in await pool.fetch(
            """SELECT chunk_index, content FROM doc_chunks WHERE folder_id = $1
               ORDER BY chunk_index LIMIT $2""",
            f["id"], NAME_HIT_CHUNKS,
        ):
            seen.add((f["id"], r["chunk_index"]))
            results.append({"folder_id": f["id"], "folder_name": f["name"], "content": r["content"], "distance": 0.0})

    vectors, _tokens = await ai_client.embed_texts([query])
    query_vec = str(vectors[0])

    rows = await pool.fetch(
        """SELECT c.folder_id, c.chunk_index, f.drive_folder_name AS folder_name, c.content,
                  c.embedding <=> $1 AS distance
           FROM doc_chunks c
           JOIN doc_folders f ON f.id = c.folder_id
           WHERE c.folder_id = ANY($2::bigint[])
             AND c.embedding <=> $1 < $4
           ORDER BY distance
           LIMIT $3""",
        query_vec, folder_ids, TOP_K, DISTANCE_THRESHOLD,
    )
    for r in rows:
        if (r["folder_id"], r["chunk_index"]) in seen:
            continue
        results.append({k: r[k] for k in ("folder_id", "folder_name", "content", "distance")})
    return results
