# デスクトップ通知②（Web Push、2026-09-11、ユーザーからの明示的な要望「アプリを閉じていても
# 通知が来るようにしたい」）。①（frontend/src/hooks/useDesktopNotifications.ts、Web Notifications
# API・タブが開いている間のみ）に続く追加で、Service Worker（frontend/public/sw.js）が購読した
# プッシュ購読先へ、サーバー側からVAPID署名付きの暗号化プッシュを送る。
#
# routers/channels.py（A-11）・routers/dms.py（A-19）の投稿処理から、発言のINSERT・
# insert_mention_blocks完了後にasyncio.create_task()でfire-and-forget起動する
# （AIメンション応答・自動応答トリガーと同じ非同期起動パターン。投稿API自体はプッシュ送信の
# 完了を待たない）。スレッド返信（A-14）は対象外——①がunread_count/unread_mention_countの
# 増分（thread_parent_id IS NULLのみ集計、A-05参照）を見ているのと同じスコープに揃えている。
import asyncio
import json
import os

from pywebpush import WebPushException, webpush

from database import ROOT_ENV, get_pool
from mentions import mention_summary


def _env(key: str, default: str | None = None) -> str | None:
    # 他のservices（ai_client.py・google_auth.py・storage.py）と同じ、ルート.env（database.ROOT_ENV）
    # へのフォールバックパターン。os.environには実プロセス環境変数（本番Fly secrets等）のみ乗る
    return os.environ.get(key) or ROOT_ENV.get(key) or default


VAPID_PRIVATE_KEY = _env("VAPID_PRIVATE_KEY")
VAPID_PUBLIC_KEY = _env("VAPID_PUBLIC_KEY")
VAPID_SUBJECT = _env("VAPID_SUBJECT", "mailto:admin@kogasoftware.com")

_EXCERPT_MAX = 80


def is_configured() -> bool:
    return bool(VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY)


def _excerpt(body: str) -> str:
    body = body.strip()
    return body if len(body) <= _EXCERPT_MAX else body[:_EXCERPT_MAX] + "…"


def _send_sync(sub_row, payload: dict) -> tuple[bool, int | None]:
    """pywebpushは内部でrequestsを使う同期処理のため、呼び出し元でスレッドに逃がす前提の関数。
    戻り値は (このsubscriptionを削除すべきか, HTTPステータス)。"""
    try:
        webpush(
            subscription_info={
                "endpoint": sub_row["endpoint"],
                "keys": {"p256dh": sub_row["p256dh"], "auth": sub_row["auth"]},
            },
            data=json.dumps(payload),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": VAPID_SUBJECT},
        )
        return False, 201
    except WebPushException as e:
        status = e.response.status_code if e.response is not None else None
        # 404/410はブラウザ側が購読を失効させたことを意味する（端末の長期未使用、ブラウザの
        # サイトデータ削除等）。以後送り続けても無駄なためDBから削除する
        return status in (404, 410), status
    except Exception:
        return False, None


async def _send_to_subscription(sub_row, payload: dict) -> None:
    should_delete, _status = await asyncio.to_thread(_send_sync, sub_row, payload)
    if should_delete:
        await get_pool().execute("DELETE FROM push_subscriptions WHERE id = $1", sub_row["id"])


async def notify_channel_message(
    channel_id: int, sender_id: int, sender_name: str, body: str, blocks: list[dict], url: str,
) -> None:
    """A-11投稿後に呼ぶ。notif_mode='mentions'の利用者には、この発言が実際に自分宛て
    （個人宛てメンション／@channel／@here）のときだけ送る（①のクライアント側ロジックと同じ判断
    基準。mentions.mention_summaryでブロックから判定する）。DMと異なりnotif_modeを尊重する。"""
    if not is_configured():
        return
    pool = get_pool()
    channel_name = await pool.fetchval("SELECT name FROM channels WHERE id = $1", channel_id)
    if channel_name is None:
        return
    channel_wide, mentioned_ids = mention_summary(blocks)
    rows = await pool.fetch(
        """SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, u.id AS user_id, u.notif_mode
           FROM channel_members cm
           JOIN users u ON u.id = cm.user_id
           JOIN push_subscriptions ps ON ps.user_id = u.id
           WHERE cm.channel_id = $1 AND cm.user_id != $2""",
        channel_id, sender_id,
    )
    body_excerpt = _excerpt(body)
    for r in rows:
        is_mentioned = channel_wide or str(r["user_id"]) in mentioned_ids
        if r["notif_mode"] == "mentions" and not is_mentioned:
            continue
        title = "あなたへのメンション" if is_mentioned else f"#{channel_name}"
        payload = {
            "title": title, "body": f"{sender_name}: {body_excerpt}", "url": url, "tag": f"kogack-c-{channel_id}",
        }
        await _send_to_subscription(r, payload)


async def notify_dm_message(dm_id: int, sender_id: int, sender_name: str, body: str, url: str) -> None:
    """A-19投稿後に呼ぶ。DMは①と同じくnotif_modeに関わらず常に通知対象とする
    （DM自体が既に「自分宛て」であるため。useDesktopNotifications.tsのisDm扱いと同じ）。"""
    if not is_configured():
        return
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
           FROM direct_message_members dmm
           JOIN push_subscriptions ps ON ps.user_id = dmm.user_id
           WHERE dmm.dm_id = $1 AND dmm.user_id != $2""",
        dm_id, sender_id,
    )
    body_excerpt = _excerpt(body)
    payload = {"title": sender_name, "body": body_excerpt, "url": url, "tag": f"kogack-d-{dm_id}"}
    for r in rows:
        await _send_to_subscription(r, payload)
