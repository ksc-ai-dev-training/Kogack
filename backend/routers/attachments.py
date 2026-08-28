# A-21〜A-22（詳細設計書 API設計4.5節、基本設計書5.4節 F-07 ファイル共有）。
#
# T-06 message_attachments.message_idはNOT NULLのため、アップロード時点（A-21）ではDB行を作らず
# ファイル実体のみをディスクへ保存する（attachments.pyのコメント参照）。クライアントはA-21の
# レスポンス（file_name/byte_size/storage_path）を保持しておき、A-11/A-14/A-19への投稿リクエストに
# attachmentsとして含めることで、確定したmessage_idに紐づくT-06行が作られる。
#
# 本番はSupabase Storageを想定する設計（基本設計書2.2節）だが、A-61アイコンアップロードと同じ考え方で
# ローカル開発はbackend/uploads/attachments へのディスク保存で代替する（Koyeb実配備時はSupabase Storageへの
# 置き換えが必要）。アイコン（全認証済み利用者に公開）と異なり、添付ファイルはチャンネル/DM参加者限定の
# 公開範囲とする（基本設計書6.2節「設計判断」）ため、ダウンロード（A-22）はrequire_thread_accessと同じ
# 権限判定を経由する。
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from auth_helpers import CurrentUser, require_auth, require_thread_access
from database import get_pool

router = APIRouter(prefix="/api/attachments", tags=["attachments"])

_MAX_BYTES = 20 * 1024 * 1024  # 20MB（05-1_詳細設計書_DB設計.html 3.6節）

UPLOAD_DIR = Path(__file__).resolve().parent.parent / "uploads" / "attachments"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@router.post("", status_code=201)
async def upload_attachment(file: UploadFile = File(...), user: CurrentUser = Depends(require_auth)):
    """A-21: ファイルアップロード。20MBまで、ファイル形式の制限は無い（要件定義書F-07）。
    まだどの発言にも紐づいていないため、DB行はここでは作らずディスクへ保存するのみ
    （attachments.pyのモジュールコメント参照）。"""
    data = await file.read()
    if len(data) > _MAX_BYTES:
        raise HTTPException(400, detail="ファイルサイズは20MBまでです")
    if not data:
        raise HTTPException(400, detail="空のファイルはアップロードできません")
    original_name = file.filename or "ファイル"
    ext = Path(original_name).suffix
    storage_name = f"{uuid.uuid4().hex}{ext}"
    (UPLOAD_DIR / storage_name).write_bytes(data)
    return {"file_name": original_name, "byte_size": len(data), "storage_path": storage_name}


@router.get("/{attachment_id}")
async def download_attachment(attachment_id: int, user: CurrentUser = Depends(require_auth)):
    """A-22: ファイルダウンロード。添付先の発言の参加者のみ（require_thread_accessを流用し、
    元発言が非公開チャンネルの非参加者には404、公開チャンネルの非参加者には403、DMの非参加者には
    404を返す。総論5.3節と同じ使い分け）。"""
    row = await get_pool().fetchrow(
        "SELECT message_id, file_name, storage_path FROM message_attachments WHERE id = $1", attachment_id
    )
    if row is None:
        raise HTTPException(404, detail="見つかりません")
    await require_thread_access(message_id=row["message_id"], user=user)

    path = (UPLOAD_DIR / row["storage_path"]).resolve()
    if not path.is_relative_to(UPLOAD_DIR.resolve()) or not path.is_file():
        raise HTTPException(404, detail="見つかりません")
    # media_typeを固定してブラウザでのインライン表示（例: アップロードされたHTMLの実行）を避け、
    # 常にダウンロードとして扱う
    return FileResponse(path, filename=row["file_name"], media_type="application/octet-stream")
