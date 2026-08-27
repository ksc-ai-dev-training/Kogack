# JWT発行/検証、権限ヘルパー（詳細設計書 総論 5.1節）
import os
import time
from dataclasses import dataclass

import jwt
from fastapi import Depends, HTTPException, Request

from database import APP_ENV, get_pool

_DEV_SECRET = "dev-secret-change-me"
JWT_SECRET = os.environ.get("JWT_SECRET", _DEV_SECRET)
if APP_ENV == "production" and JWT_SECRET == _DEV_SECRET:
    # 開発用の既定鍵のまま本番起動するとセッションを偽造できてしまうため、起動時に落とす
    raise RuntimeError("APP_ENV=production では JWT_SECRET の設定が必須です")
JWT_EXPIRES_SECONDS = int(os.environ.get("JWT_EXPIRES_SECONDS", str(12 * 3600)))
SESSION_COOKIE = "kogack_session"
# 本番（HTTPS）ではセッションCookieに Secure 属性を付与する
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1" if APP_ENV == "production" else "0") == "1"


@dataclass
class CurrentUser:
    id: int
    email: str
    name: str
    role: str
    picture_url: str | None


def issue_jwt(user_id: int, role: str) -> str:
    now = int(time.time())
    payload = {"sub": str(user_id), "role": role, "iat": now, "exp": now + JWT_EXPIRES_SECONDS}
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def verify_jwt(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(401, detail="認証が必要です")


async def require_auth(request: Request) -> CurrentUser:
    token = request.cookies.get(SESSION_COOKIE)
    if token is None:
        raise HTTPException(401, detail="認証が必要です")
    payload = verify_jwt(token)
    row = await get_pool().fetchrow(
        "SELECT id, email, name, role, is_active, picture_url FROM users WHERE id = $1",
        int(payload["sub"]),
    )
    if row is None or not row["is_active"]:
        raise HTTPException(401, detail="認証が必要です")
    return CurrentUser(
        id=row["id"], email=row["email"], name=row["name"],
        role=row["role"], picture_url=row["picture_url"],
    )


def require_roles(*roles: str):
    """role限定のAPI用デコレーター相当（詳細設計書 総論5.1節 require_admin 等）"""
    async def checker(user: CurrentUser = Depends(require_auth)) -> CurrentUser:
        if user.role not in roles:
            raise HTTPException(403, detail="権限がありません")
        return user
    return checker


def require_self_or_roles(*roles: str):
    async def checker(user_id: int, user: CurrentUser = Depends(require_auth)) -> CurrentUser:
        if user.id == user_id:
            return user
        if user.role in roles:
            return user
        raise HTTPException(403, detail="権限がありません")
    return checker


async def require_channel_member(channel_id: int, user: CurrentUser = Depends(require_auth)) -> CurrentUser:
    """チャンネル参加者限定（詳細設計書 総論5.1節・5.3節）。

    非公開チャンネルの非参加者には404（存在を伏せる）、公開チャンネルの非参加者には403を返す
    （F-34「参加していない者には一覧・検索に表示されない」を満たすため区別する）。
    """
    pool = get_pool()
    channel = await pool.fetchrow("SELECT is_public FROM channels WHERE id = $1", channel_id)
    if channel is None:
        raise HTTPException(404, detail="見つかりません")
    is_member = await pool.fetchval(
        "SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)",
        channel_id, user.id,
    )
    if is_member:
        return user
    if channel["is_public"]:
        raise HTTPException(403, detail="権限がありません")
    raise HTTPException(404, detail="見つかりません")


async def require_channel_admin(channel_id: int, user: CurrentUser = Depends(require_auth)) -> CurrentUser:
    """S-06チャンネル設定用（基本設計書4.2節「設計判断」）。当該chadminまたはシステムadminのみ許可。

    システムadminは「chadmin権限＋全チャンネルのAI設定」を持つ（総論5.1節の権限マトリクス）ため、
    そのチャンネルの参加者かどうかに関わらず許可する。chadmin側は参加確認をチェックより先に行い、
    非公開チャンネルの非参加者にはrequire_channel_memberと同じ404、参加しているがchadminでない
    場合は403を返す（chadmin判定だけで403にすると、非公開チャンネルの存在をURL直打ちで確認できて
    しまいF-34の抜け穴になるため）。
    """
    pool = get_pool()
    channel = await pool.fetchrow("SELECT is_public FROM channels WHERE id = $1", channel_id)
    if channel is None:
        raise HTTPException(404, detail="見つかりません")
    if user.role == "admin":
        return user
    member = await pool.fetchrow(
        "SELECT is_channel_admin FROM channel_members WHERE channel_id = $1 AND user_id = $2",
        channel_id, user.id,
    )
    if member is None:
        if channel["is_public"]:
            raise HTTPException(403, detail="権限がありません")
        raise HTTPException(404, detail="見つかりません")
    if member["is_channel_admin"]:
        return user
    raise HTTPException(403, detail="権限がありません")


async def require_dm_member(dm_id: int, user: CurrentUser = Depends(require_auth)) -> CurrentUser:
    """DM参加者限定（詳細設計書 総論5.1節）。DMは非公開チャンネルと違い公開/非公開の区別が無いため、
    非参加者には常に404を返す（存在自体を伏せる）。"""
    is_member = await get_pool().fetchval(
        "SELECT EXISTS(SELECT 1 FROM direct_message_members WHERE dm_id = $1 AND user_id = $2)",
        dm_id, user.id,
    )
    if not is_member:
        raise HTTPException(404, detail="見つかりません")
    return user


async def require_thread_access(message_id: int, user: CurrentUser = Depends(require_auth)) -> CurrentUser:
    """A-13/A-14用（基本設計書8.2節・詳細設計書 API設計4.3節）。スレッド元発言のchannel_id/dm_idに応じて
    require_channel_member/require_dm_memberと同じ判定を行う（元発言が非公開チャンネルなら404/403、
    DMなら404のみ）。削除済みの発言も見つからない扱いにする。"""
    pool = get_pool()
    parent = await pool.fetchrow(
        "SELECT channel_id, dm_id FROM messages WHERE id = $1 AND deleted_at IS NULL", message_id
    )
    if parent is None:
        raise HTTPException(404, detail="見つかりません")
    if parent["channel_id"] is not None:
        channel = await pool.fetchrow("SELECT is_public FROM channels WHERE id = $1", parent["channel_id"])
        is_member = await pool.fetchval(
            "SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)",
            parent["channel_id"], user.id,
        )
        if is_member:
            return user
        if channel is not None and channel["is_public"]:
            raise HTTPException(403, detail="権限がありません")
        raise HTTPException(404, detail="見つかりません")
    is_member = await pool.fetchval(
        "SELECT EXISTS(SELECT 1 FROM direct_message_members WHERE dm_id = $1 AND user_id = $2)",
        parent["dm_id"], user.id,
    )
    if not is_member:
        raise HTTPException(404, detail="見つかりません")
    return user
