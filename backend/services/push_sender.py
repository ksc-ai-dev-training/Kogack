# デスクトップ通知②（Web Push、2026-09-11、ユーザーからの明示的な要望「アプリを閉じていても
# 通知が来るようにしたい」）。①（frontend/src/hooks/useDesktopNotifications.ts、Web Notifications
# API・タブが開いている間のみ）に続く追加で、Service Worker（frontend/public/sw.js）が購読した
# プッシュ購読先へ、サーバー側からVAPID署名付きの暗号化プッシュを送る。
#
# routers/channels.py（A-11）・routers/dms.py（A-19）の投稿処理から、発言のINSERT・
# insert_mention_blocks完了後にasyncio.create_task()でfire-and-forget起動する
# （AIメンション応答・自動応答トリガーと同じ非同期起動パターン。投稿API自体はプッシュ送信の
# 完了を待たない）。スレッド返信（A-14）は全参加者への配信（notify_channel_message/
# notify_dm_message）の対象外のまま——①がunread_count/unread_mention_countの増分
# （メンション以外はthread_parent_id IS NULLのみ集計、A-05参照）を見ているのと同じスコープに
# 揃えている。ただし「自分の発言へのスレッド返信」「スレッド内でのメンション」の2つに限っては
# 個人宛ての通知として意味があるため、notify_thread_reply（2026-09-14、ユーザーからの明示的な
# 要望）で対象者だけに絞って送る。
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
    """A-11投稿後に呼ぶ。notif_mode='off'の利用者には一切送らず、'mentions'の利用者には、この
    発言が実際に自分宛て（個人宛てメンション／@channel／@here）のときだけ送る（①のクライアント側
    ロジックと同じ判断基準。mentions.mention_summaryでブロックから判定する）。
    チャンネルごとの通知設定（channel_members.notif_mode、2026-09-11）が'default'以外の場合は
    全体設定（users.notif_mode）より優先する——このチャンネルに限った上書きという位置づけ。"""
    if not is_configured():
        return
    pool = get_pool()
    channel_name = await pool.fetchval("SELECT name FROM channels WHERE id = $1", channel_id)
    if channel_name is None:
        return
    channel_wide, mentioned_ids = mention_summary(blocks)
    rows = await pool.fetch(
        """SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, u.id AS user_id, u.notif_mode,
               cm.notif_mode AS channel_notif_mode
           FROM channel_members cm
           JOIN users u ON u.id = cm.user_id
           JOIN push_subscriptions ps ON ps.user_id = u.id
           WHERE cm.channel_id = $1 AND cm.user_id != $2""",
        channel_id, sender_id,
    )
    body_excerpt = _excerpt(body)
    for r in rows:
        effective_mode = r["channel_notif_mode"] if r["channel_notif_mode"] != "default" else r["notif_mode"]
        if effective_mode == "off":
            continue
        is_mentioned = channel_wide or str(r["user_id"]) in mentioned_ids
        if effective_mode == "mentions" and not is_mentioned:
            continue
        title = "あなたへのメンション" if is_mentioned else f"#{channel_name}"
        payload = {
            "title": title, "body": f"{sender_name}: {body_excerpt}", "url": url, "tag": f"kogack-c-{channel_id}",
        }
        await _send_to_subscription(r, payload)


async def notify_dm_message(dm_id: int, sender_id: int, sender_name: str, body: str, url: str) -> None:
    """A-19投稿後に呼ぶ。DMは①と同じく'mentions'/'all'の区別なく常に通知対象とする（DM自体が
    既に「自分宛て」であるため。useDesktopNotifications.tsのisDm扱いと同じ）。ただし'off'
    （2026-09-11追加、ユーザーからの要望「通知をオフにするオプション」）のときはDMも含め
    一切送らない——「オフ」は文字どおり全面的な無効化であるべきという判断（基本設計書6.2節）。"""
    if not is_configured():
        return
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, u.notif_mode
           FROM direct_message_members dmm
           JOIN users u ON u.id = dmm.user_id
           JOIN push_subscriptions ps ON ps.user_id = u.id
           WHERE dmm.dm_id = $1 AND dmm.user_id != $2""",
        dm_id, sender_id,
    )
    body_excerpt = _excerpt(body)
    payload = {"title": sender_name, "body": body_excerpt, "url": url, "tag": f"kogack-d-{dm_id}"}
    for r in rows:
        if r["notif_mode"] == "off":
            continue
        await _send_to_subscription(r, payload)


async def notify_thread_reply(
    *, channel_id: int | None, dm_id: int | None, thread_parent_id: int, sender_id: int,
    sender_name: str, body: str, blocks: list[dict], url: str,
) -> None:
    """A-14（スレッド返信）投稿後に呼ぶ。通常のスレッド返信は全参加者への配信対象外のままだが、
    (1) そのスレッドの元発言を書いた本人への「自分の発言への返信」通知、(2) この返信で個人宛て
    メンションされた利用者への通知、(3) そのスレッドに過去に一度でも返信したことがある利用者への
    通知、の3つに限り送る（ユーザーからの明示的な要望「自分の発言に対してスレッドで返信が来た時と、
    スレッド内でメンションされたときにも通知が来てほしい」、2026-09-14。続けて同日「自分が一回でも
    発言したことのあるスレッドで新しい返信が来たときも通知が来るようにすべき」との追加要望を受け(3)を
    追加した。Slackの既定の「スレッドをwatchする」挙動と同じ考え方）。@channel/@hereはスレッド返信の
    候補一覧に出さない設計（ChannelView.tsx）のためmention_summaryのchannel_wideは実質発生しないが、
    ここでは無視するだけで安全（万一混入しても「全員配信」扱いにはしない）。対象者は元発言の投稿者＋
    メンションされた利用者＋過去の返信者のみに絞るため、notify_channel_message/notify_dm_messageの
    ようにchannel_members/direct_message_members全員を起点にせず、先にuser_idの集合を確定させてから
    その人たちだけをJOINで引く。"""
    if not is_configured():
        return
    pool = get_pool()
    thread_root = await pool.fetchrow("SELECT sender_user_id FROM messages WHERE id = $1", thread_parent_id)
    root_author_id = thread_root["sender_user_id"] if thread_root else None
    past_repliers = await pool.fetch(
        "SELECT DISTINCT sender_user_id FROM messages WHERE thread_parent_id = $1 AND sender_user_id IS NOT NULL",
        thread_parent_id,
    )
    _channel_wide, mentioned_ids = mention_summary(blocks)
    target_ids = {int(uid) for uid in mentioned_ids}
    if root_author_id is not None:
        target_ids.add(root_author_id)
    target_ids.update(r["sender_user_id"] for r in past_repliers)
    target_ids.discard(sender_id)
    if not target_ids:
        return

    if channel_id is not None:
        rows = await pool.fetch(
            """SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, u.id AS user_id, u.notif_mode,
                   cm.notif_mode AS channel_notif_mode
               FROM channel_members cm
               JOIN users u ON u.id = cm.user_id
               JOIN push_subscriptions ps ON ps.user_id = u.id
               WHERE cm.channel_id = $1 AND u.id = ANY($2::bigint[])""",
            channel_id, list(target_ids),
        )
    else:
        rows = await pool.fetch(
            """SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth, u.id AS user_id, u.notif_mode,
                   NULL::text AS channel_notif_mode
               FROM direct_message_members dmm
               JOIN users u ON u.id = dmm.user_id
               JOIN push_subscriptions ps ON ps.user_id = u.id
               WHERE dmm.dm_id = $1 AND u.id = ANY($2::bigint[])""",
            dm_id, list(target_ids),
        )
    body_excerpt = _excerpt(body)
    for r in rows:
        effective_mode = (
            r["channel_notif_mode"] if r["channel_notif_mode"] not in (None, "default") else r["notif_mode"]
        )
        if effective_mode == "off":
            continue
        # ここに来る時点で対象者は「メンションされた」「自分のスレッドへの返信」「そのスレッドへの
        # 過去の返信者」のいずれか（複数該当もありうる）に該当することが確定しているため、
        # 'mentions'モードでも通知してよい（notify_channel_messageと異なり追加のモード判定は不要）
        is_mentioned = str(r["user_id"]) in mentioned_ids
        if is_mentioned:
            title = "あなたへのメンション"
        elif r["user_id"] == root_author_id:
            title = "あなたの発言への返信"
        else:
            title = "参加中のスレッドに新着"
        payload = {
            "title": title, "body": f"{sender_name}: {body_excerpt}", "url": url,
            "tag": f"kogack-t-{thread_parent_id}",
        }
        await _send_to_subscription(r, payload)
