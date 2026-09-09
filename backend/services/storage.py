# Supabase Storageラッパー（基本設計書2.2節。プロフィール画像・チャンネルAI等のアイコン=A-61、
# 会話添付ファイル=A-21/A-22の本番保存先）。
#
# 呼び出し前にSupabaseダッシュボードで2つのバケットを作成しておく必要がある（このモジュール自体は
# バケット作成を行わない。DATABASE_URLと同じく、インフラの初期セットアップはユーザー側の作業）。
#   - ICON_BUCKET（既定 "icons"）: Public バケットとして作成する。アイコンは全認証済み利用者に
#     公開する設計（CLAUDE.md「現状のドキュメントから読み取れる主要な設計判断」）のため、
#     公開URLをそのままpicture_url等へ保存してよい。
#   - ATTACHMENT_BUCKET（既定 "attachments"）: Private バケットとして作成する。添付ファイルは
#     チャンネル/DM参加者限定の公開範囲（基本設計書6.2節「設計判断」）のため、公開URLは発行せず、
#     必ずこのモジュール経由（サービスロールキーでの取得）でバックエンドがバイト列を仲介する。
#
# SUPABASE_URL・SUPABASE_SERVICE_ROLE_KEYが未設定の場合はis_configured()がFalseを返し、呼び出し元
# （routers/icons.py・routers/attachments.py）がローカルディスク保存へフォールバックする
# （DATABASE_URL/OPENAI_API_KEYと同じ、環境変数の有無で本番/ローカル開発を切り替える既存パターン）。
import os

import httpx

from database import ROOT_ENV

SUPABASE_URL = (os.environ.get("SUPABASE_URL") or ROOT_ENV.get("SUPABASE_URL") or "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ROOT_ENV.get("SUPABASE_SERVICE_ROLE_KEY") or ""
)

ICON_BUCKET = os.environ.get("SUPABASE_ICON_BUCKET") or ROOT_ENV.get("SUPABASE_ICON_BUCKET") or "icons"
ATTACHMENT_BUCKET = (
    os.environ.get("SUPABASE_ATTACHMENT_BUCKET") or ROOT_ENV.get("SUPABASE_ATTACHMENT_BUCKET") or "attachments"
)


def is_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


class StorageError(Exception):
    pass


def _headers(content_type: str | None = None) -> dict[str, str]:
    headers = {
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
    }
    if content_type:
        headers["Content-Type"] = content_type
    return headers


async def upload(bucket: str, path: str, data: bytes, content_type: str) -> None:
    """指定パスへアップロードする（既存があれば上書き、x-upsert指定）。"""
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{path}"
    headers = _headers(content_type)
    headers["x-upsert"] = "true"
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.post(url, content=data, headers=headers)
    if res.status_code >= 300:
        raise StorageError(f"Supabase Storageへのアップロードに失敗しました: {res.status_code} {res.text[:200]}")


async def download(bucket: str, path: str) -> bytes:
    """指定パスのバイト列を取得する。存在しない場合はFileNotFoundError。"""
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{path}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        res = await client.get(url, headers=_headers())
    if res.status_code == 404:
        raise FileNotFoundError(path)
    if res.status_code >= 300:
        raise StorageError(f"Supabase Storageからの取得に失敗しました: {res.status_code} {res.text[:200]}")
    return res.content


def public_url(bucket: str, path: str) -> str:
    """Publicバケット向け。ICON_BUCKET専用（ATTACHMENT_BUCKETはPrivateのため使わない）。"""
    return f"{SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}"
