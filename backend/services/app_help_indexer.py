# 操作マニュアル（backend/app_help/manual.md）をチャンネルAIが常に検索できるようにする索引化
# （ユーザーからの明示的な要望「作成した操作マニュアルの内容を、どのチャンネルのAIでも常に
# 読めるようにする」、2026-09-16）。docs/06_操作マニュアル.htmlそのものはdocsフォルダごと
# .dockerignoreで本番Dockerイメージから除外される（CLAUDE.md「Keirekiからの意図的な相違点」
# 節参照ではなく、2026-09-04の.dockerignore整備時の判断）ため、あらかじめプレーンテキストへ
# 書き起こした複製をbackend/配下（Dockerイメージに含まれる範囲）に置いている。services/
# doc_indexer.pyと同じチャンク分割・埋め込みベクトル化のパターンを踏襲するが、doc_folders/
# channel_doc_foldersのようなper-channel ACL・opt-in構造は使わない（このマニュアルは
# アプリ自体の使い方という全チャンネル共通の知識であり、管理者の登録操作を介さず常時全
# チャンネルで検索可能にすべきため。services/app_help_search.py参照）。
import hashlib
from pathlib import Path

from database import get_pool
from services import ai_client

MANUAL_PATH = Path(__file__).resolve().parent.parent / "app_help" / "manual.md"

# doc_indexer.pyのCHUNK_SIZE/CHUNK_OVERLAPと同じ考え方（文字数ベースの単純な分割、
# text-embedding-3-smallの8191トークン上限に十分収まる範囲）。マニュアルは1ファイルのみ
# でMAX_CHUNKS相当の上限は不要（実測で12件程度のチャンクにしかならない）。
CHUNK_SIZE = 1200
CHUNK_OVERLAP = 150


def _chunk_text(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = end - CHUNK_OVERLAP
    return chunks


async def ensure_indexed() -> None:
    """アプリ起動時（main.pyのlifespan）に呼ぶ。backend/app_help/manual.mdの内容のハッシュが
    前回索引化時（app_help_index_state.source_hash）と異なる場合のみ、OpenAI Embeddings APIを
    呼んで全チャンクを作り直す（AUTO_MIGRATEの冪等パターンと同じ考え方——無条件に毎起動
    再索引すると起動時間・APIコストが無駄に嵩む）。OPENAI_API_KEY未設定時は他のAI機能と
    同じく早期returnで何もしない。索引化に失敗してもアプリ起動自体は妨げない（この機能が
    無くても他のAI応答・既存の会話機能は動作するため、例外を握りつぶしログのみ出す）。"""
    if not ai_client.is_configured():
        return
    if not MANUAL_PATH.exists():
        print(f"[app_help_indexer] {MANUAL_PATH} が見つかりません。スキップします")
        return

    text = MANUAL_PATH.read_text(encoding="utf-8")
    source_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()

    pool = get_pool()
    existing_hash = await pool.fetchval("SELECT source_hash FROM app_help_index_state WHERE id = 1")
    if existing_hash == source_hash:
        return

    try:
        chunks = _chunk_text(text)
        if not chunks:
            return
        vectors, _tokens = await ai_client.embed_texts(chunks)
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute("DELETE FROM app_help_chunks")
            await conn.executemany(
                "INSERT INTO app_help_chunks (chunk_index, content, embedding) VALUES ($1, $2, $3)",
                [(i, chunk, str(vec)) for i, (chunk, vec) in enumerate(zip(chunks, vectors))],
            )
            await conn.execute(
                """INSERT INTO app_help_index_state (id, source_hash, updated_at) VALUES (1, $1, now())
                   ON CONFLICT (id) DO UPDATE SET source_hash = $1, updated_at = now()""",
                source_hash,
            )
        print(f"[app_help_indexer] indexed {len(chunks)} chunk(s) from manual.md")
    except Exception as e:
        # バックグラウンド的な起動時処理の例外はどこにも表示されず握りつぶされるだけなので、
        # 原因を問わず必ずここで捕捉してログへ残す（doc_indexer.pyと同じ意図的な広いexcept）
        print(f"[app_help_indexer] indexing failed: {e}")
