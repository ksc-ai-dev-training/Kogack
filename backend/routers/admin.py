# A-36/A-37（詳細設計書 API設計4.8節、基本設計書3.3節・S-08利用者管理）
# このスライスは利用者管理タブのみ実装。ドキュメント参照範囲・AI利用状況・監査ログの3タブは
# Drive連携・AI呼び出し・監査ログ基盤が未実装のため対象外（CLAUDE.md 実装状況節）。
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_roles
from database import get_pool

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/users")
async def list_users(user: CurrentUser = Depends(require_roles("admin"))):
    """A-36: 利用者一覧。chadmin_channelsは参考表示のみ（変更はS-06チャンネル管理者タブで行う）"""
    rows = await get_pool().fetch(
        """SELECT u.id, u.name, u.email, u.role, u.is_active, u.last_login_at,
               COALESCE(array_agg(c.name ORDER BY c.name) FILTER (WHERE cm.is_channel_admin), '{}')
                   AS chadmin_channels
           FROM users u
           LEFT JOIN channel_members cm ON cm.user_id = u.id AND cm.is_channel_admin
           LEFT JOIN channels c ON c.id = cm.channel_id
           GROUP BY u.id
           ORDER BY u.name"""
    )
    return {
        "items": [
            {
                "id": str(r["id"]), "name": r["name"], "email": r["email"], "role": r["role"],
                "is_active": r["is_active"],
                "last_login_at": r["last_login_at"].isoformat() if r["last_login_at"] else None,
                "chadmin_channels": list(r["chadmin_channels"]),
            }
            for r in rows
        ]
    }


class UpdateUserRequest(BaseModel):
    role: str | None = None
    is_active: bool | None = None


@router.put("/users/{target_id}")
async def update_user(
    target_id: int, body: UpdateUserRequest, user: CurrentUser = Depends(require_roles("admin")),
):
    """A-37: ロール変更・有効/無効化。自分自身の無効化・adminからの降格は管理者ロックアウト防止のため拒否する"""
    if body.role is not None and body.role not in ("member", "admin"):
        raise HTTPException(422, detail="roleはmember/adminのいずれかです")
    if target_id == user.id and body.is_active is False:
        raise HTTPException(400, detail="自分自身を無効化することはできません")
    if target_id == user.id and body.role == "member":
        raise HTTPException(400, detail="自分自身をmemberに降格することはできません")

    pool = get_pool()
    exists = await pool.fetchval("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)", target_id)
    if not exists:
        raise HTTPException(404, detail="見つかりません")

    if body.role is not None:
        await pool.execute("UPDATE users SET role = $2, updated_at = now() WHERE id = $1", target_id, body.role)
    if body.is_active is not None:
        await pool.execute(
            "UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1", target_id, body.is_active
        )

    row = await pool.fetchrow("SELECT id, role, is_active FROM users WHERE id = $1", target_id)
    return {"id": str(row["id"]), "role": row["role"], "is_active": row["is_active"]}
