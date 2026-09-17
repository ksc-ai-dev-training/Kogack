# アプリ上でのファイルプレビュー対象形式の判定（画像・PDF・プレーンテキストのみ）。
# もともとF-07添付ファイルプレビュー（routers/attachments.py、2026-09-11）に実装した
# ロジックを、S-08参照ドキュメントプレビュー（routers/admin.py、2026-09-17）・チャット上の
# 引用（citation）プレビュー（routers/messages.py、2026-09-17）でも同じ判定基準が必要になり
# 3箇所へコピーが増えたため、共通モジュールへ抽出した。SVGは画像として一般的だがインライン
# スクリプトを実行できる既知のリスクがあるため意図的に対象外にしている。
from pathlib import Path

PREVIEW_IMAGE_EXT = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"}
PREVIEW_TEXT_EXT = {".txt", ".md", ".csv", ".json", ".log"}


def preview_content_type(file_name: str) -> str | None:
    """プレビュー対象として安全と判断した拡張子ならContent-Typeを返す。対象外（未対応形式・
    拡張子偽装によるものを含め一切）はNoneを返し、呼び出し元は404でプレビューを拒否する。
    テキストは実際のファイル内容に関わらず常にtext/plainとして返す（例えば.mdファイルの中身に
    <script>タグが書かれていても、ブラウザにHTMLとして解釈・実行させないための防御）。"""
    ext = Path(file_name).suffix.lower()
    if ext in PREVIEW_IMAGE_EXT:
        return PREVIEW_IMAGE_EXT[ext]
    if ext == ".pdf":
        return "application/pdf"
    if ext in PREVIEW_TEXT_EXT:
        return "text/plain; charset=utf-8"
    return None
