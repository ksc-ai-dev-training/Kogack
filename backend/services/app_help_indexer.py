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
import re
from pathlib import Path

from database import get_pool
from services import ai_client

MANUAL_PATH = Path(__file__).resolve().parent.parent / "app_help" / "manual.md"

# ハッシュにこの値も含めることで、manual.md自体は変えずに_chunk_textのアルゴリズムだけを
# 変更した場合でも再索引が走るようにする（2026-09-17、チャンク分割方法を見直した際に
# 「内容のハッシュだけを見ていると、コード側のロジック変更が検知されず古いチャンクが
# 残り続ける」という穴に気づいたため。分割ロジックを変えるたびにこの数値を上げること）。
CHUNKER_VERSION = 2

# doc_indexer.pyのCHUNK_SIZE/CHUNK_OVERLAPと同じ役割（1チャンクの上限と重複幅）だが、
# _chunk_textの分割方法自体はdoc_indexer.pyの単純な文字数区切りとは異なる（下記_chunk_text
# のdocstring参照）。オーバーサイズなブロックが出た場合のフォールバック分割にのみ使う。
CHUNK_SIZE = 1200
CHUNK_OVERLAP = 150

_BULLET_PREFIX = "- "


def _split_bullets(block: str) -> tuple[str, list[str]]:
    """空行を含まない1ブロック内の行を、先頭の説明文（intro）と「- 」で始まる箇条書き
    項目（items）へ分ける。マニュアルは読みやすさのため長い箇条書き項目を複数の物理行に
    手動で折り返して書いている箇所があるため、「- 」で始まらない行は直前の項目の続きとして
    連結する（単純に改行の有無だけでは項目境界を判定できない）。"""
    intro_lines: list[str] = []
    items: list[list[str]] = []
    for raw_line in block.split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith(_BULLET_PREFIX):
            items.append([line])
        elif items:
            items[-1].append(line)
        else:
            intro_lines.append(line)
    intro = " ".join(intro_lines)
    bullets = [" ".join(item) for item in items]
    return intro, bullets


def _fallback_split(piece: str) -> list[str]:
    """想定より長いブロック（将来マニュアルが拡充された場合の保険）だけ、doc_indexer.pyと
    同じ文字数ベースの単純な分割にフォールバックする。通常のmanual.mdの内容ではここを
    通らない（全ブロックがCHUNK_SIZE未満）。"""
    if len(piece) <= CHUNK_SIZE:
        return [piece] if piece else []
    out, start = [], 0
    while start < len(piece):
        end = start + CHUNK_SIZE
        p = piece[start:end].strip()
        if p:
            out.append(p)
        start = end - CHUNK_OVERLAP
    return out


_HEADING_BLOCK_RE = re.compile(r"^#")


def _chunk_text(text: str) -> list[str]:
    """Markdown構造（`## 見出し` と空行区切りの段落）に沿ってチャンクを作る。
    doc_indexer.pyと同じ文字数ベースの機械的な分割は使わない——ユーザーからの報告
    （2026-09-17、「予約コメントの使い方」を尋ねても案内できない）を受けて調査したところ、
    1チャンク＝1200文字固定の単純分割では、目的の語句（例:「送信予約」）が実際にチャンク内に
    存在していても、同じチャンクに他の無関係な話題（チャンネル管理者タブ・AI設定タブ群の
    説明など）が大量に同居しているためembeddingが薄まり、コサイン距離がDISTANCE_THRESHOLD
    （0.7、doc_search.pyと共有）を超えて検索にヒットしないことが判明した。マニュアルは
    自分たちで「1見出し＝1トピック、1段落（空行区切り）＝1機能の説明」という構成で書いている
    ため、この構造をそのままチャンク境界として使うことで、各チャンクの語彙的な焦点を絞る。
    さらに、1段落の中に「- 」で始まる箇条書き項目が2つ以上ある場合（例: AI設定7タブの一覧、
    メンション候補の一覧、よくある質問の各行）は、それぞれの項目を独立したチャンクへさらに
    分割する（見出し＋段落の先頭説明文を文脈として各項目に前置きする）。1つの段落・チャンク
    にまとめたままだと、7つの異なるタブ名・複数のFAQ項目が1つのembeddingへ混ざり、個々の
    項目についての狭い質問（例:「参照ドキュメント範囲タブとは」）の検索精度が同様に落ちるため。
    見出しのみのブロック（`## N. タイトル`単体）はそれ自体をチャンクにはせず、以後のブロックの
    文脈（`current_heading`）として各チャンク本文の先頭に付与する。"""
    text = text.strip()
    if not text:
        return []
    chunks: list[str] = []
    current_heading = ""
    for raw_block in re.split(r"\n\s*\n", text):
        block = raw_block.strip()
        if not block:
            continue
        if _HEADING_BLOCK_RE.match(block):
            current_heading = block.lstrip("#").strip()
            continue
        intro, bullets = _split_bullets(block)
        if len(bullets) >= 2:
            for bullet in bullets:
                piece = f"{current_heading}\n{intro}\n{bullet}" if intro else f"{current_heading}\n{bullet}"
                chunks.extend(_fallback_split(piece.strip()))
        else:
            piece = f"{current_heading}\n{block}" if current_heading else block
            chunks.extend(_fallback_split(piece.strip()))
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
    source_hash = hashlib.sha256(f"{CHUNKER_VERSION}:{text}".encode("utf-8")).hexdigest()

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
