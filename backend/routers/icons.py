# A-61（詳細設計書 API設計4.5節）。個人（F-37）・チャンネルAI（A-25）・BOT/トリガー（A-54/A-55）の
# アイコンをまとめて扱う汎用アップロードAPI。アップロード自体に権限制約は無く、返却されたURLを
# 実際に設定する側（A-25/A-54/A-55/A-62）で権限を検証する（基本設計書API一覧「設計判断」）。
#
# 本番はSupabase Storageを想定する設計（基本設計書2.2節）。SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
# が設定されていれば services/storage.py 経由でSupabase Storageへ保存し、公開URLをそのまま返す
# （アイコンは全認証済み利用者に公開する設計のためPublicバケットでよい）。未設定時（ローカル開発）は
# DATABASE_URLと同じ考え方で backend/uploads/icons へのディスク保存にフォールバックする
# （2026-09-09、CLAUDE.md実装状況「Fly.ioストレージ検討」を参照。SupabaseアカウントとFly.ioの
# 契約主体の違いから、アイコン・添付ファイルはSupabase Storageに統一する結論になった）。
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from auth_helpers import CurrentUser, require_auth
from services import storage

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

    if storage.is_configured():
        try:
            await storage.upload(storage.ICON_BUCKET, filename, data, file.content_type)
        except storage.StorageError as e:
            raise HTTPException(502, detail=str(e))
        return {"url": storage.public_url(storage.ICON_BUCKET, filename)}

    (UPLOAD_DIR / filename).write_bytes(data)
    return {"url": f"/api/icons/{filename}"}


@router.get("/{filename}")
async def get_icon(filename: str, user: CurrentUser = Depends(require_auth)):
    """アップロード済みアイコン画像の配信。会話添付ファイルと異なり全認証済み利用者に公開する
    （発言者表示のため組織内のあらゆる画面に登場しうる性質のもので、機密情報ではないと判断。
    CLAUDE.md「現状のドキュメントから読み取れる主要な設計判断」）。**Supabase Storage設定時は
    upload_iconがそちらの公開URLを直接返すためこのエンドポイントは呼ばれない。ローカル開発
    （ディスク保存）向けのフォールバックとしてのみ残している。**"""
    path = (UPLOAD_DIR / filename).resolve()
    if not path.is_relative_to(UPLOAD_DIR.resolve()) or not path.is_file():
        raise HTTPException(404, detail="見つかりません")
    return FileResponse(path)
