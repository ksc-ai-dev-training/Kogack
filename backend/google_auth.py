# Google OAuth 2.0 認可URL生成・トークン交換・IDトークン検証・ドメイン検証（詳細設計書 総論2章 / API設計4.2節）
import os
import secrets
from urllib.parse import urlencode

import httpx
import jwt
from jwt import PyJWKClient

from database import ROOT_ENV

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs"
# IDトークンの発行者。Googleはこの2種類のどちらかを使う
VALID_ISSUERS = ("https://accounts.google.com", "accounts.google.com")

STATE_COOKIE = "kogack_oauth_state"
STATE_MAX_AGE = 600  # state Cookie は10分で失効させる（短命Cookie）


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key) or ROOT_ENV.get(key, default)


GOOGLE_CLIENT_ID = _env("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = _env("GOOGLE_CLIENT_SECRET")
# 許可ドメイン（REQ-N-01）。カンマ区切りで複数指定できる
ALLOWED_DOMAINS = [
    d.strip().lower() for d in _env("ALLOWED_DOMAINS", "kogasoftware.com").split(",") if d.strip()
]
# リダイレクトURI。未設定なら実行中のリクエストのホストから組み立てる
GOOGLE_REDIRECT_URI = _env("GOOGLE_REDIRECT_URI")

# JWKS は公開鍵の取得元。PyJWKClient が鍵をキャッシュするためモジュールレベルで1つ持つ
_jwk_client = PyJWKClient(JWKS_URI, cache_keys=True)


def is_configured() -> bool:
    return bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)


def new_state() -> str:
    """CSRF対策の state を生成する（A-01）"""
    return secrets.token_urlsafe(32)


def redirect_uri_for(request) -> str:
    """コールバックURL。GOOGLE_REDIRECT_URI 未設定時はリクエストのホストから導出する。

    Koyeb など TLS 終端がプロキシ側にある環境では request.url.scheme が http になることが
    あるため、X-Forwarded-Proto を優先して https を保つ。
    """
    if GOOGLE_REDIRECT_URI:
        return GOOGLE_REDIRECT_URI
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    return f"{proto}://{host}/api/auth/callback"


def build_auth_url(state: str, redirect_uri: str) -> str:
    """Google の認可エンドポイントURLを組み立てる（A-01）。

    層2ドキュメントQ&A（F-19〜F-22）向けに2026-09-07から一時的にdrive.readonlyスコープを
    含めていたが、Google Workspace管理コンソールのdomainPolicyブロック（2026-09-08に判明。
    千田氏もこの設定を変更できる権限を持たない）により実際にはDrive APIを呼び出せないままで、
    2026-09-09に層2の実装自体を実ファイルアップロード方式（Drive非依存）へ切り替え済み。
    Driveスコープを求め続けると、実際には使っていない権限をログインのたびに要求する不要な
    同意画面が表示され続けるだけになる（ユーザーからの指摘で2026-09-10に判明し撤去した）ため、
    ログインに必要な最小スコープへ戻した。access_type=offline・prompt=consentもrefresh_token
    （Driveアクセストークンの自動更新用）を確実に受け取るためだけに付けていたものなので、
    あわせて外した（毎回の同意画面もこれで無くなる）。
    """
    params = {
        "client_id": GOOGLE_CLIENT_ID,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        # UX向上のためのドメインヒント。実際の検証はサーバー側（verify_domain）で行う
        "hd": ALLOWED_DOMAINS[0] if ALLOWED_DOMAINS else "",
        # 複数アカウント運用での誤ログインを防ぐため常にアカウント選択を出す
        "prompt": "select_account",
    }
    return f"{AUTH_ENDPOINT}?{urlencode({k: v for k, v in params.items() if v})}"


async def exchange_code(code: str, redirect_uri: str) -> dict:
    """認可コードをトークンに交換する（A-02 手順4）。返り値は id_token を含むトークンレスポンス"""
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.post(
            TOKEN_ENDPOINT,
            data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if res.status_code != 200:
        raise ValueError(f"トークン交換に失敗しました: {res.status_code} {res.text[:200]}")
    return res.json()


async def refresh_access_token(refresh_token: str) -> dict:
    """refresh_tokenを使ってaccess_tokenを更新する（層2ドキュメントQ&A、T-23 google_drive_tokens用）。
    Googleはrefresh_token更新のレスポンスに新しいrefresh_tokenを含めないのが通常のため、
    呼び出し元は既存のrefresh_tokenをそのまま使い続ける（レスポンスのaccess_token・expires_inのみ
    更新して保存する）。"""
    async with httpx.AsyncClient(timeout=10) as client:
        res = await client.post(
            TOKEN_ENDPOINT,
            data={
                "refresh_token": refresh_token,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "grant_type": "refresh_token",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if res.status_code != 200:
        raise ValueError(f"トークン更新に失敗しました: {res.status_code} {res.text[:200]}")
    return res.json()


def verify_id_token(id_token: str) -> dict:
    """IDトークンの署名・発行者・audience を検証し、クレームを返す（A-02 手順4）。

    署名検証には Google の公開鍵（JWKS）を使う。検証を省くと任意のトークンを
    受け入れてしまうため、必ず署名・iss・aud をすべて検証する。
    leeway=60はexp/iatの検証にのみ効き、ローカルマシンとGoogle側のわずかな時刻のずれ
    （NTP同期済みでも数秒程度は生じうる）でImmatureSignatureError等が誤発生するのを防ぐ
    （実際にローカル環境で発生を確認済み。署名・iss・audの検証は厳密なまま緩めない）。
    """
    signing_key = _jwk_client.get_signing_key_from_jwt(id_token)
    claims = jwt.decode(
        id_token,
        signing_key.key,
        algorithms=["RS256"],
        audience=GOOGLE_CLIENT_ID,
        leeway=60,
        options={"require": ["exp", "iat", "aud", "iss", "sub"]},
    )
    if claims.get("iss") not in VALID_ISSUERS:
        raise ValueError("IDトークンの発行者が不正です")
    return claims


def verify_domain(email: str) -> bool:
    """許可ドメインのアカウントか検証する（REQ-N-01）"""
    if not email or "@" not in email:
        return False
    return email.rsplit("@", 1)[1].lower() in ALLOWED_DOMAINS
