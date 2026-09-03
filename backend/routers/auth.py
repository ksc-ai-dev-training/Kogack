# A-01〜A-04 認証系API（詳細設計書 API設計4.2節、総論9.1節）
# ローカル開発では Google OAuth の代わりに dev-login を使う（Keirekiと同じ規約。設計書には
# 記載のない開発者向けの利便機能で、本番では常に無効）
import os
import secrets
import traceback

import audit_log
import google_auth
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from auth_helpers import COOKIE_SECURE, SESSION_COOKIE, CurrentUser, issue_jwt, require_auth
from database import APP_ENV, get_pool

router = APIRouter(prefix="/api/auth", tags=["auth"])

GOOGLE_CLIENT_ID = google_auth.GOOGLE_CLIENT_ID
# Google OAuth 未設定時は開発用ログインを有効にする（DEV_AUTH=0 で明示無効化）。
# ただし APP_ENV=production では DEV_AUTH=1 を指定しても常に無効。
DEV_AUTH = (
    APP_ENV != "production"
    and os.environ.get("DEV_AUTH", "0" if GOOGLE_CLIENT_ID else "1") == "1"
)


def _login_error_redirect(reason: str) -> RedirectResponse:
    """S-01 にエラー種別を伝えて戻す（詳細設計書 総論7.2節の3種類）"""
    res = RedirectResponse(f"/login?error={reason}", status_code=302)
    res.delete_cookie(google_auth.STATE_COOKIE, path="/")
    return res


@router.get("/login")
async def login(request: Request):
    """A-01: Google OAuth 2.0 の認可URLへリダイレクトする"""
    if not google_auth.is_configured():
        raise HTTPException(
            501, detail="Google OAuth が未設定です（開発中は開発用ログインを使用してください）"
        )
    state = google_auth.new_state()
    url = google_auth.build_auth_url(state, google_auth.redirect_uri_for(request))
    response = RedirectResponse(url, status_code=302)
    # state は短命Cookieに保存し、コールバックで照合する（CSRF対策）
    response.set_cookie(
        google_auth.STATE_COOKIE, state, httponly=True, samesite="lax", path="/",
        secure=COOKIE_SECURE, max_age=google_auth.STATE_MAX_AGE,
    )
    return response


@router.get("/callback")
async def callback(
    request: Request, code: str | None = None, state: str | None = None, error: str | None = None,
):
    """A-02: OAuthコールバック（総論9.1節の手順どおり）。

    state照合 → トークン交換 → IDトークン検証 → ドメイン照合 →
    ユーザー登録/取得 → JWT発行 → / へリダイレクト。
    """
    if not google_auth.is_configured():
        raise HTTPException(501, detail="Google OAuth が未設定です")

    expected = request.cookies.get(google_auth.STATE_COOKIE)
    state_ok = bool(state and expected and secrets.compare_digest(state, expected))

    # Googleが同意画面を「キャンセル」された場合等はcodeの代わりにerror（access_denied等）を返す。
    # 従来はcode不足を一律「state不一致」と同じoauth_failed（「もう一度お試しください」とだけ表示し
    # 理由を伝えない）にしていたため、利用者が同意画面（Drive権限拡張後は特に）を拒否すると、なぜ
    # 失敗したか分からないまま何度試しても同じ結果になり、チャット機能自体にもログインできなくなる
    # 不具合があった（ユーザーからの報告を受けて修正）。stateがCookie値と照合できた場合のみ信頼する
    # （state不一致のまま偽のerror値を送りつけられても専用メッセージには誘導しない）
    if error and state_ok:
        print(f"[auth] google returned error on callback: {error}")
        return _login_error_redirect("consent_denied" if error == "access_denied" else "oauth_failed")

    # 1. state をCookie保存値と照合（不一致は不正リクエストとして拒否）
    if not code or not state_ok:
        # CSRF・cookieの取りこぼし・二重送信等の切り分けに使うログ（元は原因調査用の一時追加だったが、
        # oauth_failedは詳細をフロントに返さない設計のため恒久的に残すことにした）
        print(f"[auth] state mismatch: code={bool(code)} state={bool(state)} "
              f"expected_cookie={bool(expected)} cookies={list(request.cookies.keys())}")
        return _login_error_redirect("oauth_failed")

    # 2. code をIDトークンに交換し、署名・発行者・audience を検証
    try:
        token = await google_auth.exchange_code(code, google_auth.redirect_uri_for(request))
        claims = google_auth.verify_id_token(token["id_token"])
    except Exception:
        # oauth_failedはフロントに詳細を返さないため、原因（トークン交換失敗・署名検証失敗・
        # clock skewによるIDトークン検証エラー等）を追えるよう恒久的にtracebackを出力する
        # （元は原因調査用の一時追加。実際にPyJWTのleeway不足によるImmatureSignatureErrorの
        # 特定に使い、google_auth.pyのverify_id_tokenにleeway=60を追加して解消した）
        traceback.print_exc()
        return _login_error_redirect("oauth_failed")

    email = (claims.get("email") or "").lower()
    # メール未確認のアカウントは他人のアドレスを騙れるため拒否する
    if not claims.get("email_verified", False):
        return _login_error_redirect("oauth_failed")

    # 3. 許可ドメインの照合（REQ-N-01）
    if not google_auth.verify_domain(email):
        return _login_error_redirect("domain_not_allowed")

    name = claims.get("name") or email.split("@")[0]
    picture = claims.get("picture")

    # 4. T-01 users をメールアドレスで検索。未登録なら role='member' で自動登録（初回ログイン）
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT id, role, is_active FROM users WHERE lower(email) = $1", email
    )
    is_new = row is None
    if is_new:
        row = await pool.fetchrow(
            """INSERT INTO users (email, name, role, picture_url)
               VALUES ($1, $2, 'member', $3) RETURNING id, role, is_active""",
            email, name, picture,
        )
    else:
        # 5. 無効化されたユーザーはログイン拒否
        if not row["is_active"]:
            return _login_error_redirect("account_disabled")
        # Kogackは再ログインのたびにGoogle側のname/picture_urlで上書きしない
        # （F-39: 本人がA-62で変更した表示名・アイコンを優先する設計判断。基本設計書5.20節）。
        # KeirekiのようにここでUPDATEしないのが正しい実装であることに注意。

    # S-08利用者管理の「最終ログイン」表示用（05-3画面設計backfill）
    await pool.execute("UPDATE users SET last_login_at = now() WHERE id = $1", row["id"])
    # S-08監査ログタブ用（T-16、05-1 DB設計3.12節）
    await audit_log.record(
        pool, "login", row["id"], "初回ログイン（新規登録）でログインしました" if is_new else "ログインしました",
    )

    # 6. セッションJWTを HttpOnly Cookie に設定して / へ戻す
    token_jwt = issue_jwt(row["id"], row["role"])
    response = RedirectResponse("/", status_code=302)
    response.set_cookie(
        SESSION_COOKIE, token_jwt, httponly=True, samesite="lax", path="/", secure=COOKIE_SECURE
    )
    response.delete_cookie(google_auth.STATE_COOKIE, path="/")
    return response


class DevLoginRequest(BaseModel):
    email: str


@router.post("/dev-login")
async def dev_login(body: DevLoginRequest, response: Response):
    """開発用ログイン（Google認証の代替）。登録済みメールアドレスでJWTを発行する。

    A-02 のドメイン検証・自動登録に相当する流れを簡略化したもので、本番では無効。
    """
    if not DEV_AUTH:
        raise HTTPException(404, detail="Not Found")
    row = await get_pool().fetchrow(
        "SELECT id, role, is_active FROM users WHERE email = $1", body.email
    )
    if row is None:
        raise HTTPException(403, detail="登録されていないユーザーです（seed.py を実行してください）")
    if not row["is_active"]:
        raise HTTPException(403, detail="このアカウントは無効化されています")
    pool = get_pool()
    await pool.execute("UPDATE users SET last_login_at = now() WHERE id = $1", row["id"])
    # 開発用ログインもA-02と同じ流れの簡略版として扱い、同じくaudit_logsへ記録する（S-08監査ログタブ）
    await audit_log.record(pool, "login", row["id"], "ログインしました")
    token = issue_jwt(row["id"], row["role"])
    response.set_cookie(
        SESSION_COOKIE, token, httponly=True, samesite="lax", path="/", secure=COOKIE_SECURE
    )
    return {"detail": "ログインしました"}


@router.get("/dev-users")
async def dev_users():
    """開発用: ログイン可能なユーザー一覧（S-01 のアカウント選択に使用）。本番では無効。"""
    if not DEV_AUTH:
        raise HTTPException(404, detail="Not Found")
    rows = await get_pool().fetch(
        "SELECT email, name, role FROM users WHERE is_active = true ORDER BY id"
    )
    return {"items": [dict(r) for r in rows]}


@router.post("/logout")
async def logout(response: Response, user: CurrentUser = Depends(require_auth)):
    # A-03: セッションCookie破棄
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"detail": "ログアウトしました"}


@router.get("/me")
async def me(user: CurrentUser = Depends(require_auth)):
    # A-04: ログイン中ユーザー情報
    return {
        "id": str(user.id), "email": user.email, "name": user.name,
        "role": user.role, "picture_url": user.picture_url,
    }
