# A-61（詳細設計書 API設計4.5節）。個人（F-37）・チャンネルAI（A-25）・BOT/トリガー（A-54/A-55）の
# アイコンをまとめて扱う汎用アップロードAPI。アップロード自体に権限制約は無く、返却されたURLを
# 実際に設定する側（A-25/A-54/A-55/A-62）で権限を検証する（基本設計書API一覧「設計判断」）。
#
# 本番はSupabase Storageを想定する設計（基本設計書2.2節）だが、このスライスではDATABASE_URLと同じ
# 考え方でローカル開発を優先し、backend/uploads/icons へのディスク保存で代替する。Fly.ioへの実配備時は
# 単一コンテナに永続ディスクの保証が無いため、Supabase Storageへの置き換えが必要（CLAUDE.md実装状況）。
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from auth_helpers import CurrentUser, require_auth

router = APIRouter(prefix="/api/icons", tags=["icons"])

_ALLOWED_CONTENT_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
_MAX_BYTES = 5 * 1024 * 1024

UPLOAD_DIR = Path(__file__).resolve().parent.parent / "uploads" / "icons"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@router.post("", status_code=201)
async def upload_icon(file: UploadFile = File(...), user: CurrentUser = Depends(require_auth)):
    """A-61: JPEG/PNG/WebP、5MBまで。認証済みであれば誰でも呼べる（アップロード自体は無害）。"""
    ext = _ALLOWED_CONTENT_TYPES.get(file.content_type)
    if ext is None:
        raise HTTPException(400, detail="JPEG・PNG・WebP形式のみアップロードできます")
    data = await file.read()
    if len(data) > _MAX_BYTES:
        raise HTTPException(400, detail="ファイルサイズは5MBまでです")
    filename = f"{uuid.uuid4().hex}{ext}"
    (UPLOAD_DIR / filename).write_bytes(data)
    return {"url": f"/api/icons/{filename}"}


@router.get("/{filename}")
async def get_icon(filename: str, user: CurrentUser = Depends(require_auth)):
    """アップロード済みアイコン画像の配信。会話添付ファイルと異なり全認証済み利用者に公開する
    （発言者表示のため組織内のあらゆる画面に登場しうる性質のもので、機密情報ではないと判断。
    CLAUDE.md「現状のドキュメントから読み取れる主要な設計判断」）。"""
    path = (UPLOAD_DIR / filename).resolve()
    if not path.is_relative_to(UPLOAD_DIR.resolve()) or not path.is_file():
        raise HTTPException(404, detail="見つかりません")
    return FileResponse(path)
