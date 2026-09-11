# A-21〜A-22（詳細設計書 API設計4.5節、基本設計書5.4節 F-07 ファイル共有）。
#
# T-06 message_attachments.message_idはNOT NULLのため、アップロード時点（A-21）ではDB行を作らず
# ファイル実体のみを保存する（このファイルのコメント参照）。クライアントはA-21のレスポンス
# （file_name/byte_size/storage_path）を保持しておき、A-11/A-14/A-19への投稿リクエストに
# attachmentsとして含めることで、確定したmessage_idに紐づくT-06行が作られる。
#
# 本番はSupabase Storageを想定する設計（基本設計書2.2節）。SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY
# が設定されていれば services/storage.py 経由でSupabase Storageへ保存する。アイコン（全認証済み
# 利用者に公開）と異なり、添付ファイルはチャンネル/DM参加者限定の公開範囲とする（基本設計書6.2節
# 「設計判断」）ため、Attachmentバケットは必ずPrivateとし、ダウンロード（A-22）はrequire_thread_access
# と同じ権限判定を経由してこのバックエンドがバイト列を仲介する（クライアントへ直接のバケットURLは
# 渡さない）。未設定時（ローカル開発）は backend/uploads/attachments へのディスク保存に
# フォールバックする（2026-09-09、CLAUDE.md実装状況「Fly.ioストレージ検討」を参照）。
import uuid
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse

from auth_helpers import CurrentUser, require_auth, require_thread_access
from database import get_pool
from services import storage

router = APIRouter(prefix="/api/attachments", tags=["attachments"])

_MAX_BYTES = 20 * 1024 * 1024  # 20MB（05-1_詳細設計書_DB設計.html 3.6節）

# アプリ上でのファイルプレビュー（ユーザーからの明示的な要望「画像ファイルや文書ファイル、PDF、
# テキストファイルをクリックするとダウンロードされる仕組みになると思うが、このファイルをアプリ上で
# 表示させることはできますか」、2026-09-11）。A-22ダウンロードは意図的に全形式をoctet-stream＋
# Content-Disposition: attachmentに固定し、ブラウザでのインライン実行（例: アップロードされた
# HTMLの実行）を避ける設計判断をしていた。この安全策は維持しつつ、明確に安全と判断できる形式
# （画像・PDF・プレーンテキスト）だけを対象に、別エンドポイント（/preview）で正しいContent-Type・
# inlineとして配信する。**SVGは画像として一般的だがインラインスクリプトを実行できる既知のリスクが
# あるため、意図的にプレビュー対象から除外している**（A-22が全形式を固定していた本来の理由と同じ）。
# Word/Excel/PowerPoint等は元々ブラウザがネイティブ表示できないため対象外のまま（引き続きA-22の
# ダウンロードのみ）。
_PREVIEW_IMAGE_EXT = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp"}
_PREVIEW_TEXT_EXT = {".txt", ".md", ".csv", ".json", ".log"}


def _preview_content_type(file_name: str) -> str | None:
    """プレビュー対象として安全と判断した拡張子ならContent-Typeを返す。対象外（未対応形式・
    拡張子偽装によるものを含め一切）はNoneを返し、呼び出し元は404でプレビューを拒否する。
    テキストは実際のファイル内容に関わらず常にtext/plainとして返す（例えば.mdファイルの中身に
    <script>タグが書かれていても、ブラウザにHTMLとして解釈・実行させないための防御）。"""
    ext = Path(file_name).suffix.lower()
    if ext in _PREVIEW_IMAGE_EXT:
        return _PREVIEW_IMAGE_EXT[ext]
    if ext == ".pdf":
        return "application/pdf"
    if ext in _PREVIEW_TEXT_EXT:
        return "text/plain; charset=utf-8"
    return None

UPLOAD_DIR = Path(__file__).resolve().parent.parent / "uploads" / "attachments"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@router.post("", status_code=201)
async def upload_attachment(file: UploadFile = File(...), user: CurrentUser = Depends(require_auth)):
    """A-21: ファイルアップロード。20MBまで、ファイル形式の制限は無い（要件定義書F-07）。
    まだどの発言にも紐づいていないため、DB行はここでは作らず保存するのみ（本ファイル冒頭コメント参照）。"""
    data = await file.read()
    if len(data) > _MAX_BYTES:
        raise HTTPException(400, detail="ファイルサイズは20MBまでです")
    if not data:
        raise HTTPException(400, detail="空のファイルはアップロードできません")
    original_name = file.filename or "ファイル"
    ext = Path(original_name).suffix
    storage_name = f"{uuid.uuid4().hex}{ext}"

    if storage.is_configured():
        try:
            await storage.upload(
                storage.ATTACHMENT_BUCKET, storage_name, data, file.content_type or "application/octet-stream"
            )
        except storage.StorageError as e:
            raise HTTPException(502, detail=str(e))
    else:
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

    # media_typeを固定してブラウザでのインライン表示（例: アップロードされたHTMLの実行）を避け、
    # 常にダウンロードとして扱う。日本語ファイル名対応はFileResponse（ローカルディスク経路）と同じ
    # RFC5987（filename*=utf-8''...）をSupabase経路でも手動で組み立てる。
    ascii_fallback = row["file_name"].encode("ascii", "replace").decode("ascii")
    headers = {
        "Content-Disposition": (
            f'attachment; filename="{ascii_fallback}"; filename*=utf-8\'\'{quote(row["file_name"])}'
        )
    }

    if storage.is_configured():
        try:
            data = await storage.download(storage.ATTACHMENT_BUCKET, row["storage_path"])
        except FileNotFoundError:
            raise HTTPException(404, detail="見つかりません")
        except storage.StorageError as e:
            raise HTTPException(502, detail=str(e))
        return Response(content=data, media_type="application/octet-stream", headers=headers)

    path = (UPLOAD_DIR / row["storage_path"]).resolve()
    if not path.is_relative_to(UPLOAD_DIR.resolve()) or not path.is_file():
        raise HTTPException(404, detail="見つかりません")
    return FileResponse(path, filename=row["file_name"], media_type="application/octet-stream")


@router.get("/{attachment_id}/preview")
async def preview_attachment(attachment_id: int, user: CurrentUser = Depends(require_auth)):
    """アプリ上でのファイルプレビュー（ユーザーからの明示的な要望、2026-09-11。冒頭のコメント参照）。
    権限判定はA-22ダウンロードと全く同じ（require_thread_access）順序で行う——先に参加者かどうかを
    確認してから「この形式はプレビュー非対応」を返すことで、非参加者に対しては形式の情報すら
    渡さない（既存のA-22・総論5.3節「存在を伏せる」と同じ考え方を崩さない）。"""
    row = await get_pool().fetchrow(
        "SELECT message_id, file_name, storage_path FROM message_attachments WHERE id = $1", attachment_id
    )
    if row is None:
        raise HTTPException(404, detail="見つかりません")
    await require_thread_access(message_id=row["message_id"], user=user)

    content_type = _preview_content_type(row["file_name"])
    if content_type is None:
        raise HTTPException(404, detail="この形式はアプリ内でのプレビューに対応していません")

    ascii_fallback = row["file_name"].encode("ascii", "replace").decode("ascii")
    headers = {
        "Content-Disposition": (
            f'inline; filename="{ascii_fallback}"; filename*=utf-8\'\'{quote(row["file_name"])}'
        )
    }

    if storage.is_configured():
        try:
            data = await storage.download(storage.ATTACHMENT_BUCKET, row["storage_path"])
        except FileNotFoundError:
            raise HTTPException(404, detail="見つかりません")
        except storage.StorageError as e:
            raise HTTPException(502, detail=str(e))
    else:
        path = (UPLOAD_DIR / row["storage_path"]).resolve()
        if not path.is_relative_to(UPLOAD_DIR.resolve()) or not path.is_file():
            raise HTTPException(404, detail="見つかりません")
        data = path.read_bytes()

    if content_type.startswith("text/plain"):
        # テキストは実際のバイト列をUTF-8として解釈し直して返す（元のエンコーディングが不明でも
        # 表示自体は継続させ、壊れた文字はreplaceで代替文字にする）
        text = data.decode("utf-8", errors="replace")
        return Response(content=text, media_type=content_type, headers=headers)
    return Response(content=data, media_type=content_type, headers=headers)
