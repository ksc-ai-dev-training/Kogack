# 層2参照ドキュメント（アップロード方式、doc_folders.source='upload'）の保存先。
#
# 本番はFly Volume（/data、fly.tomlの[[mounts]]でマウント。CLAUDE.md実装状況節を参照）を使う。
# ローカル開発では/dataが存在しないため、DATABASE_URL等と同じ考え方でbackend/uploads/docsへの
# ディスク保存にフォールバックする。プロフィール画像・添付ファイル（services/storage.py、
# Supabase Storage）とはあえて別のインフラにしている（個人のSupabaseアカウントと会社契約の
# Fly.ioという契約主体の違いから、参照ドキュメントだけFly.io側に置く方針で合意済み）。
import os
import uuid
from pathlib import Path

_FLY_VOLUME_DIR = Path("/data")
_LOCAL_FALLBACK_DIR = Path(__file__).resolve().parent.parent / "uploads" / "docs"

DOC_DIR = _FLY_VOLUME_DIR if _FLY_VOLUME_DIR.is_dir() else _LOCAL_FALLBACK_DIR
DOC_DIR.mkdir(parents=True, exist_ok=True)


def save(data: bytes, *, ext: str) -> str:
    """バイト列を保存し、storage_path（DOC_DIR配下の相対ファイル名）を返す。"""
    filename = f"{uuid.uuid4().hex}{ext}"
    (DOC_DIR / filename).write_bytes(data)
    return filename


def read(storage_path: str) -> bytes:
    path = (DOC_DIR / storage_path).resolve()
    if not path.is_relative_to(DOC_DIR.resolve()) or not path.is_file():
        raise FileNotFoundError(storage_path)
    return path.read_bytes()


def delete(storage_path: str) -> None:
    path = (DOC_DIR / storage_path).resolve()
    if path.is_relative_to(DOC_DIR.resolve()) and path.is_file():
        os.remove(path)
