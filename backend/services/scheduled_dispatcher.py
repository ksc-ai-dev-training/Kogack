# F-35送信予約・F-36定期投稿のディスパッチャ（基本設計書5.15節・5.16節・10章）。FastAPI起動時から
# 稼働する30秒間隔のasyncioバックグラウンドタスクとして実装し、専用ジョブキュー（Celery等）は
# 導入しない（database.py T-18の設計判断コメントと同じ。単一インスタンス運用が前提）。
#
# [F-35] scheduled_at を過ぎた pending 行を検出すると、通常のメッセージ投稿（A-11/A-14/A-19相当）と
# 同じ経路でmessagesへ発言化する。@メンションの構造化（T-07）はscheduled_messages.mentions
# （予約時点の指定をJSONBで保持）をinsert_mention_blocksへ渡し、実際に発言化するこのタイミングで
# 参加者チェック込みでT-07へ反映する（routers/scheduled_messages.pyのコメント参照）。BOT発言の
# 枠組み（F-36/F-38/F-43）とは異なりsender_type='human'として投稿するため、AIサポート実装後は
# 通常どおり@メンションでAIエージェントが起動できる（基本設計書5.15節「実際の送信時点で通常どおり
# トリガーされる」）。
#
# [F-36] is_active=true かつ next_run_at<=now() の定期投稿ルールを検出すると、sender_type='bot'の
# 発言を作成し、頻度に応じてnext_run_atを次回時刻へ進める（'once'はis_active=falseに変更して
# 終了する）。アプリの停止等でnext_run_atを過ぎても検出できなかった場合、次回起動時のポーリングで
# 直ちに送信する（欠落回をスキップしない。F-35と同じ考え方、基本設計書5.16節）。@メンションの構造化
# （T-07）はF-35と同じ考え方でrecurring_posts.mentionsをinsert_mention_blocksへ渡し、発言化する
# このタイミングで参加者チェック込みでT-07へ反映する（2026-09-15追加。routers/recurring_posts.pyの
# コメント参照）。BOT発言（F-36/F-38/F-43共通の枠組み）はsender_type='human'の投稿のみを自動応答
# トリガー（F-38）起動の対象とする一貫原則（連鎖起動防止）にそのまま従うため、trigger_matcherは
# 定期投稿からは呼ばない。**ただしチャンネルAIへの@メンション応答（ai_agent.maybe_trigger）のみ、
# 2026-09-15にユーザーからの明示的な要望を受けて例外にした**（force_mention=Trueで呼ぶ。詳細は
# ai_agent.maybe_triggerのdocstring参照。定期投稿の書き込み経路はS-06管理画面のみで、AIの応答自体が
# 新たな定期投稿を生成することは無いため、この例外が連鎖起動を生む経路にはならない）。
import asyncio
import calendar
import json
import traceback
from datetime import datetime, timedelta

from database import get_pool
from mentions import MentionInput, insert_mention_blocks
from services import ai_agent, trigger_matcher

POLL_INTERVAL_SECONDS = 30

_task: asyncio.Task | None = None


def _next_run_after(current: datetime, anchor: datetime, frequency: str) -> datetime:
    """'weekly'は初回日時の曜日、'monthly'は初回日時（anchor）の日にちを基準に次回時刻を計算する
    （画面モックアップS-06の説明どおり）。'monthly'で該当日が存在しない月（例: 31日起点の2月）は
    月末に繰り下げる（基本設計書6.2節「設計判断」、T-19 recurring_postsの同種の既存記載と同じ考え方）。
    時刻（時分秒）はcurrent（＝直前のnext_run_at）のものをそのまま維持する。"""
    if frequency == "daily":
        return current + timedelta(days=1)
    if frequency == "weekly":
        return current + timedelta(days=7)
    if frequency == "monthly":
        year = current.year + (current.month // 12)
        month = current.month % 12 + 1
        last_day = calendar.monthrange(year, month)[1]
        day = min(anchor.day, last_day)
        return current.replace(year=year, month=month, day=day)
    raise ValueError(f"unsupported frequency: {frequency}")


async def _dispatch_due_messages() -> None:
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT id, channel_id, dm_id, thread_parent_id, sender_user_id, body, mentions, scheduled_at
           FROM scheduled_messages WHERE status = 'pending' AND scheduled_at <= now()"""
    )
    for row in rows:
        async with pool.acquire() as conn, conn.transaction():
            # 単一インスタンス運用が前提のため通常は競合しないが、念のため取得と同時に
            # status='pending'を条件にUPDATEし、二重発言化を防ぐ（基本設計書10章「設計判断」）。
            claimed = await conn.fetchval(
                "UPDATE scheduled_messages SET status = 'sent', sent_at = now() "
                "WHERE id = $1 AND status = 'pending' RETURNING id",
                row["id"],
            )
            if claimed is None:
                continue
            # バグ修正（2026-09-04）: created_atを本来の予定時刻（scheduled_at）にする。
            # _dispatch_recurring_postsと同じ理由（アプリの長時間停止からの復帰直後は、実際の
            # ディスパッチ時刻ではなく予約時刻どおりに見えるべき）。updated_atはDEFAULT now()のまま
            # （sinceポーリングの差分検知に使うため過去の時刻にしない）
            message_row = await conn.fetchrow(
                """INSERT INTO messages
                       (channel_id, dm_id, thread_parent_id, sender_type, sender_user_id, body, created_at)
                   VALUES ($1, $2, $3, 'human', $4, $5, $6) RETURNING id""",
                row["channel_id"], row["dm_id"], row["thread_parent_id"], row["sender_user_id"], row["body"],
                row["scheduled_at"],
            )
            if row["channel_id"] is not None:
                raw_mentions = row["mentions"]
                mentions_data = json.loads(raw_mentions) if isinstance(raw_mentions, str) else raw_mentions
                if mentions_data:
                    # バグ修正（2026-09-14、ユーザーからの報告「自分宛にメンションしたメッセージを
                    # 予約投稿すると、なぜか時間になっても正常に送られません」）: insert_mention_blocks
                    # の引数はDM対応（2026-09-07）・@channel/@here対応（2026-09-10/11）を経て
                    # `(conn, message_id, mentions, *, channel_id=None, dm_id=None, sender_user_id=None)`
                    # （channel_idはキーワード専用）へ変わっていたが、この呼び出し元は当時の
                    # `(conn, message_id, channel_id, mentions)`という古い位置引数のまま更新されて
                    # いなかった。これは実際には呼び出せない（TypeError: takes 3 positional
                    # arguments but 4 were given）シグネチャの不一致で、mentionsが1件でもある予約
                    # メッセージは発言化のたびにこの例外でトランザクションごとロールバックされ
                    # （元のstatus='pending'に戻る）、次の30秒ポーリングでも同じ箇所で必ず再度
                    # クラッシュするため、永久に送信されないまま無限に再試行し続けていた
                    # （`_run_loop`のtry/exceptがtick単位の例外を握りつぶすため、ディスパッチャ自体は
                    # 生き続けるが、この特定の予約メッセージだけが決して発言化されない状態になる）。
                    # sender_user_idも渡すようにした（@here対応、送信者自身をアクティブ参加者の
                    # スナップショットから除外するために使う。当時@hereはまだ存在せず未対応だった）
                    await insert_mention_blocks(
                        conn, message_row["id"], [MentionInput(**m) for m in mentions_data],
                        channel_id=row["channel_id"], sender_user_id=row["sender_user_id"],
                    )
            if row["thread_parent_id"] is not None:
                # バグ修正（2026-09-14）: routers/messages.py post_replyと同じ理由。予約投稿が
                # スレッド返信の場合も元発言のupdated_atを更新しないと、本体タイムラインの
                # sinceポーリングが「N件の返信」の増分を拾えない
                await conn.execute(
                    "UPDATE messages SET updated_at = now() WHERE id = $1", row["thread_parent_id"]
                )
        if row["channel_id"] is not None:
            # バグ修正（2026-09-14、ユーザーからの報告「メンションでAIに呼びかけたメッセージを
            # 予約投稿してもAIが反応しない」）: A-11（channels.post_message）・A-14
            # （messages.post_reply）はいずれもメッセージ作成後にtrigger_matcher.maybe_trigger
            # （F-38自動応答トリガー）・ai_agent.maybe_trigger（チャンネルAIへの@メンション応答）を
            # 呼んでいるが、この予約投稿ディスパッチャは一度もこれらを呼んでおらず、予約投稿は
            # 「@Kogack AI」等のメンションを含んでいてもAIが一切反応しない・自動応答トリガーの
            # キーワードに一致していても発火しない状態だった（通常投稿・スレッド返信とは異なる
            # 発言経路のため、この抜けはcurl等の単体API検証だけでは気づけない）。
            # trigger_matcher（F-38）はスレッド返信を対象外とする既存スコープ（trigger_matcher.py
            # 冒頭コメント「対象はA-11のみ」）に合わせ、thread_parent_idがNULL（＝チャンネル本体の
            # 予約投稿）のときだけ呼ぶ。ai_agent.maybe_triggerはA-11・A-14の両方に対応するため
            # thread_idをそのまま渡し（NULLならチャンネル本体、非NULLならそのスレッドへの返信として
            # 応答する）、いずれも通常投稿と同じfire-and-forget（内部でasyncio.create_task）のため
            # ディスパッチループ自体をブロックしない。
            if row["thread_parent_id"] is None:
                await trigger_matcher.maybe_trigger(row["channel_id"], row["body"])
            await ai_agent.maybe_trigger(
                row["channel_id"], row["body"], row["sender_user_id"], thread_id=row["thread_parent_id"]
            )


async def _dispatch_recurring_posts() -> None:
    pool = get_pool()
    rows = await pool.fetch(
        """SELECT id, channel_id, created_by, body, mentions, bot_display_name, bot_icon, bot_icon_url,
                  frequency, anchor_at, next_run_at
           FROM recurring_posts WHERE is_active = true AND next_run_at <= now()"""
    )
    for row in rows:
        async with pool.acquire() as conn, conn.transaction():
            # scheduled_messagesと同じ「取得と同時に次の状態へUPDATEし、その結果で二重発言化を
            # 防ぐ」パターン。ここでの「次の状態」はnext_run_atを未来へ進める（'once'はis_active
            # をfalseにする）こと自体で、専用のstatus列は持たない（recurring_postsは削除するまで
            # 繰り返し処理対象であり続けるため、scheduled_messagesのような使い捨てのpending/sentとは
            # 性質が異なる）。
            if row["frequency"] == "once":
                claimed = await conn.fetchval(
                    """UPDATE recurring_posts SET is_active = false, last_sent_at = now()
                       WHERE id = $1 AND is_active = true AND next_run_at <= now() RETURNING id""",
                    row["id"],
                )
            else:
                next_run_at = _next_run_after(row["next_run_at"], row["anchor_at"], row["frequency"])
                claimed = await conn.fetchval(
                    """UPDATE recurring_posts SET next_run_at = $2, last_sent_at = now()
                       WHERE id = $1 AND is_active = true AND next_run_at <= now() RETURNING id""",
                    row["id"], next_run_at,
                )
            if claimed is None:
                continue
            # バグ修正（2026-09-04）: created_atを明示的に「本来の予定時刻」（この回でfireした
            # next_run_at、＝row["next_run_at"]。上のnext_run_at変数はNEXT回用に計算し直した値
            # なので混同しないこと）にする。アプリがauto_stop_machines等で長時間停止していた場合、
            # 欠落回をスキップせずまとめて追いつかせて送信する設計（このファイル冒頭コメント）と
            # 組み合わさると、従来はcreated_atがDEFAULT now()のまま＝ディスパッチャが実際に動いた
            # 瞬間（＝チャンネルを開いてアプリが起動した瞬間）になり、複数日分が同時刻に見えてしまう
            # 不具合が実際に報告された。updated_atは意図的にDEFAULT now()のまま変更しない
            # （sinceポーリングの差分検知はupdated_at基準のため、ここを過去の時刻にすると
            # 逆にこの発言がポーリングで検知されなくなってしまう）
            message_row = await conn.fetchrow(
                """INSERT INTO messages
                       (channel_id, sender_type, body, bot_display_name, bot_icon, bot_icon_url,
                        recurring_post_id, created_at)
                   VALUES ($1, 'bot', $2, $3, $4, $5, $6, $7) RETURNING id""",
                row["channel_id"], row["body"], row["bot_display_name"], row["bot_icon"],
                row["bot_icon_url"], row["id"], row["next_run_at"],
            )
            # バグ修正（2026-09-15、ユーザーからの報告「定期投稿で＠メンションをしても通常の
            # メンションと同じ挙動にならない」）: 従来は本文へ「@氏名」と手入力できてもT-07への
            # 反映が一切無く、会話ログでのハイライト・サイドバー未読バッジ・デスクトップ通知の
            # いずれも発生しない「ただの文字列」だった。_dispatch_due_messages（F-35予約投稿）と
            # 同じ考え方で、参加者チェックはここ（実際に発言化するタイミング）で行う（recurring_posts
            # は何度も繰り返し発火するため、対象者がその時点でチャンネルを抜けている可能性は
            # 一回きりの予約投稿よりさらに高い）。sender_user_id（@here用の送信者除外）はbot発言の
            # ためNone（定期投稿には「送信者」という概念が無く、@here自体もこのスライスのUI（S-06
            # 定期投稿タブ）からは選択できないため、実質的にはuser_mentionsのみが使われる）
            raw_mentions = row["mentions"]
            mentions_data = json.loads(raw_mentions) if isinstance(raw_mentions, str) else raw_mentions
            if mentions_data:
                await insert_mention_blocks(
                    conn, message_row["id"], [MentionInput(**m) for m in mentions_data],
                    channel_id=row["channel_id"],
                )
        # 追加（2026-09-15、ユーザーからの明示的な要望「定期投稿でAIをメンションしても
        # AIがいつも通り反応するようにしてほしい」）: 定期投稿の本文がチャンネルAIへの
        # @メンションを含む場合のみ、ai_agent.maybe_triggerをforce_mention=Trueで呼ぶ
        # （このファイル冒頭コメント参照。「BOT投稿はAIエージェントを起動しない」という
        # 一貫原則の中で、この1点だけを例外にした設計判断とその理由は ai_agent.maybe_trigger
        # のdocstringに集約している）。trigger_matcher（F-38自動応答トリガー）は今回の
        # 要望の対象外のため引き続き呼ばない。
        await ai_agent.maybe_trigger(
            row["channel_id"], row["body"], row["created_by"], force_mention=True
        )


async def _run_loop() -> None:
    while True:
        try:
            await _dispatch_due_messages()
            await _dispatch_recurring_posts()
        except Exception:
            # 1回の失敗でループ自体を止めない（次の30秒後に再試行される）
            traceback.print_exc()
        await asyncio.sleep(POLL_INTERVAL_SECONDS)


def start() -> None:
    global _task
    if _task is None:
        _task = asyncio.create_task(_run_loop())


async def stop() -> None:
    global _task
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
        _task = None
