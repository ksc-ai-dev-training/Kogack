# A-62, A-67, A-68（詳細設計書 API設計4.9・4.11節）
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_helpers import CurrentUser, require_auth
from database import get_pool

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("")
async def search_users(q: str = "", limit: int = 20, user: CurrentUser = Depends(require_auth)):
    """A-68: 氏名・メールでの部分一致検索。無効化アカウントは対象外にはせず、
    フロント側（補足02）で選択不可として表示する（一覧からの意図しない排除を避ける）"""
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT id, name, email, picture_url, is_active FROM users
           WHERE name ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%'
           ORDER BY name LIMIT $2""",
        q, limit,
    )
    return {
        "items": [
            {
                "id": str(r["id"]), "name": r["name"], "email": r["email"],
                "picture_url": r["picture_url"], "is_active": r["is_active"],
            }
            for r in rows
        ]
    }


class UpdateMeRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    picture_url: str | None = None


@router.put("/me")
async def update_me(body: UpdateMeRequest, user: CurrentUser = Depends(require_auth)):
    """A-62: 自分のプロフィール更新（表示名・アイコン。F-37/F-39）。name/picture_urlはいずれも省略可
    （指定したフィールドのみ更新する）。email/roleはここでは変更できない。表示名の重複は許容し、
    UNIQUE制約を設けない（基本設計書5.20節「設計判断」）。"""
    pool = get_pool()
    if body.name is not None:
        await pool.execute("UPDATE users SET name = $2, updated_at = now() WHERE id = $1", user.id, body.name)
    if body.picture_url is not None:
        await pool.execute(
            "UPDATE users SET picture_url = $2, updated_at = now() WHERE id = $1", user.id, body.picture_url
        )
    row = await pool.fetchrow("SELECT id, email, name, role, picture_url FROM users WHERE id = $1", user.id)
    return {
        "id": str(row["id"]), "email": row["email"], "name": row["name"],
        "role": row["role"], "picture_url": row["picture_url"],
    }


@router.get("/{target_id}")
async def get_user_profile(target_id: int, user: CurrentUser = Depends(require_auth)):
    """A-67: 指定した利用者のプロフィール確認（F-40）。所属チャンネル等は含めない
    （非公開チャンネルの存在が間接的に漏れるのを避けるため。基本設計書5.21節「設計判断」）。
    既存のA-36（管理者向け利用者一覧）と同等の情報を、認証済みであれば誰でも参照できる。"""
    row = await get_pool().fetchrow(
        "SELECT id, name, email, picture_url, role FROM users WHERE id = $1", target_id
    )
    if row is None:
        raise HTTPException(404, detail="見つかりません")
    return {
        "id": str(row["id"]), "name": row["name"], "email": row["email"],
        "picture_url": row["picture_url"], "role": row["role"],
    }
