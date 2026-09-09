# 層2参照ドキュメントの索引化（Slice 3、2026-09-09。CLAUDE.md実装状況節を参照）。
# アップロードされたファイル（doc_folders.source='upload'）からテキストを抽出し、チャンクに
# 分割して埋め込みベクトル化し、doc_chunksへ保存する。Drive連携はdomainPolicyのブロックが
# 続いており実ファイルを取得できないため、source='drive'の行はこのモジュールの対象外
# （index_status='not_applicable'のまま）。
#
# 対応形式はPDF・Word（.docx）・プレーンテキスト/Markdownのみ（要件定義書F-07のような
# 「形式制限なし」ではなく、テキスト抽出できる形式に限定される。それ以外の形式は
# index_status='failed'とし、index_errorに理由を残す）。
import io

from docx import Document as DocxDocument
from pypdf import PdfReader

from database import get_pool
from services import ai_client, doc_storage

# 文字数ベースの単純なチャンク分割（トークン数の厳密なカウントは行わず、文字数を近似として
# 使う。日本語混在テキストでも1500文字であれば text-embedding-3-small の8191トークン上限に
# 十分収まる）。CHUNK_OVERLAPは前後の文脈が途中で切れて検索精度が落ちるのを緩和するための重複分。
CHUNK_SIZE = 1500
CHUNK_OVERLAP = 150
# 極端に大きな文書（数百MBのテキストを持つPDF等）で埋め込みAPIコストが際限なく膨らむのを防ぐ
# ための上限。超過分は索引化されない（検索に使えるのは先頭MAX_CHUNKS件分のみになる）。
MAX_CHUNKS = 300

_SUPPORTED_EXTENSIONS = {".pdf", ".docx", ".txt", ".md"}


class UnsupportedFormatError(Exception):
    pass


def _extract_text(data: bytes, filename: str) -> str:
    ext = ("." + filename.rsplit(".", 1)[-1].lower()) if "." in filename else ""
    if ext == ".pdf":
        reader = PdfReader(io.BytesIO(data))
        return "\n\n".join(page.extract_text() or "" for page in reader.pages)
    if ext == ".docx":
        doc = DocxDocument(io.BytesIO(data))
        return "\n".join(p.text for p in doc.paragraphs)
    if ext in (".txt", ".md"):
        return data.decode("utf-8", errors="replace")
    raise UnsupportedFormatError(f"対応していないファイル形式です（{ext or '拡張子なし'}）")


def _chunk_text(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text) and len(chunks) < MAX_CHUNKS:
        end = start + CHUNK_SIZE
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = end - CHUNK_OVERLAP
    return chunks


async def index_folder(folder_id: int) -> None:
    """アップロード済みファイル1件を索引化する。呼び出し元（routers/admin.py）が
    asyncio.create_task経由でfire-and-forget起動する想定（AI応答生成と同じパターン）。
    成功・失敗どちらでも例外を外へ伝播させず、doc_folders.index_status/index_errorへ結果を残す
    （バックグラウンドタスクの例外はどこにも表示されず握りつぶされるだけなので、必ずDBへ記録する）。"""
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT source, storage_path, drive_folder_name, mime_type FROM doc_folders WHERE id = $1", folder_id
    )
    if row is None or row["source"] != "upload":
        return

    await pool.execute("UPDATE doc_folders SET index_status = 'indexing', index_error = NULL WHERE id = $1", folder_id)
    try:
        data = doc_storage.read(row["storage_path"])
        text = _extract_text(data, row["drive_folder_name"])
        chunks = _chunk_text(text)
        if not chunks:
            raise UnsupportedFormatError("文書からテキストを抽出できませんでした（空の文書、または画像のみのPDF等）")

        vectors, _tokens = await ai_client.embed_texts(chunks)

        async with pool.acquire() as conn, conn.transaction():
            await conn.execute("DELETE FROM doc_chunks WHERE folder_id = $1", folder_id)
            await conn.executemany(
                "INSERT INTO doc_chunks (folder_id, chunk_index, content, embedding) VALUES ($1, $2, $3, $4)",
                [(folder_id, i, chunk, str(vec)) for i, (chunk, vec) in enumerate(zip(chunks, vectors))],
            )
            await conn.execute(
                "UPDATE doc_folders SET index_status = 'ready', index_error = NULL WHERE id = $1", folder_id
            )
    except Exception as e:
        # バックグラウンドタスクの例外はどこにも表示されず握りつぶされるだけなので、
        # 原因を問わず必ずここで捕捉してDBへ記録する（意図的な広いexcept）
        await pool.execute(
            "UPDATE doc_folders SET index_status = 'failed', index_error = $2 WHERE id = $1", folder_id, str(e)[:500]
        )
