# A-68のみ（詳細設計書 API設計4.9節）。DM相手選択（補足02）用の利用者検索。
# A-62/A-67（プロフィール編集）は別スライス（F-37/F-39）で追加する
from fastapi import APIRouter, Depends

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
