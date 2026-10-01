# S-08参照ドキュメントのWord（.docx）プレビュー（ユーザー要望、2026-10-01）。
# ブラウザは.docxをそのまま表示できないため、サーバー側でpython-docx（doc_indexer.pyの索引化で
# 既に依存済み）を使い、本文を見出し・段落・箇条書き・表のブロック列（JSON）へ変換して返す。
# HTMLへの変換（mammoth等）ではなく構造化データにしているのは、フロント側がReactのテキストとして
# 描画するだけで済み、文書内に仕込まれたリンク・スクリプト等をブラウザに解釈させる余地を作らない
# ため。文字装飾・画像・段組み等は再現しない（内容の確認用途に絞る）。
import io

from docx import Document as DocxDocument
from docx.table import Table
from docx.text.paragraph import Paragraph

# 極端に大きな文書でレスポンスが膨らむのを防ぐ上限（超過分は打ち切り、truncated=Trueで知らせる）
MAX_BLOCKS = 3000


def _paragraph_block(p: Paragraph) -> dict | None:
    text = p.text
    style = (p.style.name if p.style is not None else "") or ""
    if style == "Title":
        return {"type": "heading", "level": 1, "text": text}
    if style.startswith("Heading"):
        level = style.removeprefix("Heading").strip()
        return {"type": "heading", "level": min(int(level), 4) if level.isdigit() else 2, "text": text}
    # 箇条書き・番号付きリストはスタイル名（List Bullet等）か段落の番号設定（numPr）で判定する
    is_list = style.startswith("List") or p._p.pPr is not None and p._p.pPr.numPr is not None
    if is_list and text.strip():
        return {"type": "list_item", "text": text}
    return {"type": "paragraph", "text": text}


def _table_block(t: Table) -> dict:
    rows = []
    for row in t.rows:
        cells: list[dict] = []
        prev = None
        for cell in row.cells:
            # 横方向の結合セルはpython-docxでは同じセルが繰り返し返されるため、連続する重複は
            # 1つにまとめてspan（結合した列数）を数える。まとめないと列がずれ、単に捨てると
            # 行ごとの列数が揃わず表が崩れる
            if prev is not None and cell._tc is prev:
                cells[-1]["span"] += 1
                continue
            prev = cell._tc
            cells.append({"text": cell.text, "span": 1})
        rows.append(cells)
    return {"type": "table", "rows": rows}


def docx_to_blocks(data: bytes) -> dict:
    doc = DocxDocument(io.BytesIO(data))
    blocks: list[dict] = []
    truncated = False
    # doc.paragraphsとdoc.tablesは別々のリストで本文中の順序が失われるため、body要素を順に辿る
    for child in doc.element.body.iterchildren():
        if len(blocks) >= MAX_BLOCKS:
            truncated = True
            break
        if child.tag.endswith("}p"):
            block = _paragraph_block(Paragraph(child, doc))
        elif child.tag.endswith("}tbl"):
            block = _table_block(Table(child, doc))
        else:
            continue
        if block is not None:
            blocks.append(block)
    # 末尾の空段落は表示上の意味が無いので落とす
    while blocks and blocks[-1]["type"] == "paragraph" and not blocks[-1]["text"].strip():
        blocks.pop()
    return {"blocks": blocks, "truncated": truncated}
