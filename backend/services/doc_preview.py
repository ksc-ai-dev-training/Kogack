# 参照ドキュメント（doc_folders）のアプリ内プレビューの共通処理。S-08管理コンソール（routers/admin.py、
# 2026-09-17）・チャット上の引用プレビュー（routers/messages.py）・S-06チャンネル設定の参照ドキュメント
# 範囲タブ（routers/ai_settings.py、2026-10-01）の3か所が同じ形式で返す。権限の判定は呼び出し元が行い、
# ここは「実ファイルを持つアップロード文書か」の確認と、形式ごとのレスポンス生成だけを担う。
# 対応形式の判定はF-07添付ファイルと共有のservices/preview_kind.py（SVGは意図的に除外）、
# Office形式（Word・PowerPoint・Excel）は本文をブロック列のJSONへ変換して返す（services/office_preview.py）
from pathlib import Path
from urllib.parse import quote

from fastapi import HTTPException, Response

from services import doc_storage
from services.office_preview import OFFICE_EXTENSIONS, office_to_blocks
from services.preview_kind import preview_content_type


def preview_response(row):
    """rowはdoc_foldersの item_type・source・storage_path・drive_folder_name を含む行（Noneなら404）。
    フォルダ自体やDrive由来の候補（実体を持たない）は404"""
    if row is None or row["item_type"] != "file" or row["source"] != "upload" or row["storage_path"] is None:
        raise HTTPException(404, detail="見つかりません")

    ext = Path(row["drive_folder_name"]).suffix.lower()
    is_office = ext in OFFICE_EXTENSIONS
    content_type = None if is_office else preview_content_type(row["drive_folder_name"])
    if not is_office and content_type is None:
        raise HTTPException(404, detail="この形式はアプリ内でのプレビューに対応していません")

    try:
        data = doc_storage.read(row["storage_path"])
    except FileNotFoundError:
        raise HTTPException(404, detail="見つかりません")

    if is_office:
        try:
            return office_to_blocks(data, ext)
        except Exception:
            raise HTTPException(
                422, detail="ファイルを読み込めませんでした（破損しているか、拡張子と実際の形式が異なる可能性があります）"
            )

    ascii_fallback = row["drive_folder_name"].encode("ascii", "replace").decode("ascii")
    headers = {
        "Content-Disposition": (
            f'inline; filename="{ascii_fallback}"; filename*=utf-8\'\'{quote(row["drive_folder_name"])}'
        )
    }
    if content_type.startswith("text/plain"):
        # テキストは実際のバイト列をUTF-8として解釈し直して返す（壊れた文字はreplaceで代替文字にする）
        return Response(content=data.decode("utf-8", errors="replace"), media_type=content_type, headers=headers)
    return Response(content=data, media_type=content_type, headers=headers)
