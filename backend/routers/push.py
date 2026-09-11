# デスクトップ通知②（Web Push）の購読管理。VAPID公開鍵の配布・購読登録/解除のみを扱う
# （実際の送信はservices/push_sender.py、投稿系API（A-11/A-19）から起動する）
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth_helpers import CurrentUser, require_auth
from database import get_pool
from services import push_sender

router = APIRouter(prefix="/api/push", tags=["push"])


@router.get("/public-key")
async def get_public_key(user: CurrentUser = Depends(require_auth)):
    """VAPID公開鍵（configured=falseならまだ未設定＝②は使えない。フロントは①のみで動作を続ける）"""
    return {"configured": push_sender.is_configured(), "public_key": push_sender.VAPID_PUBLIC_KEY}


class SubscribeRequest(BaseModel):
    endpoint: str
    keys: dict[str, str]


@router.post("/subscribe", status_code=201)
async def subscribe(body: SubscribeRequest, user: CurrentUser = Depends(require_auth)):
    """ブラウザのPushSubscription.toJSON()をそのまま受け取る。同じ端末（endpoint）から再度
    購読された場合はp256dh/authを最新の値で上書きする（ブラウザがキーをローテーションすることがある）"""
    p256dh = body.keys.get("p256dh")
    auth = body.keys.get("auth")
    if not p256dh or not auth:
        raise HTTPException(422, detail="不正な購読情報です")
    await get_pool().execute(
        """INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, endpoint) DO UPDATE SET p256dh = $3, auth = $4""",
        user.id, body.endpoint, p256dh, auth,
    )
    return {"detail": "登録しました"}


class UnsubscribeRequest(BaseModel):
    endpoint: str


@router.post("/unsubscribe", status_code=204)
async def unsubscribe(body: UnsubscribeRequest, user: CurrentUser = Depends(require_auth)):
    # DELETEメソッドはbodyを持たない実装のブラウザ/プロキシがあるため、他のPOST系操作と揃えてPOSTにする
    await get_pool().execute(
        "DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2", user.id, body.endpoint,
    )
