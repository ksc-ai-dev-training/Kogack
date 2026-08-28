# チャンネルAIの応答生成（基本設計書8章、詳細設計書AIサポート10章）。AIサポート機能の初回スライス。
#
# このスライスのスコープ（今後拡張していく前提）:
#   - 反応モードはメンション時のみ対応する（T-08.reaction_modeの値自体はUIから編集できず常に既定の
#     'mention_only'のまま。8.1節「投稿に自ら反応」＝proactiveは次スライス以降）
#   - Function Calling（search_documents / get_seat_availability）は対象外。ドキュメント索引
#     （T-09/T-10のGoogle Drive連携）・座席予約システム連携のいずれも未実装のため、
#     プレーンな会話応答のみを行う
#   - スキル（T-11）・自動対応範囲分類（T-12）・引き継ぎ（F-17）・実行前確認（F-25）は対象外。
#     したがってT-08.out_of_scope_policy / fallback_handoff_user_idはこのスライスでは
#     プロンプトに反映されない（値は保存できるが未使用。ドキュメントQ&A実装時に使う）
#   - AI利用コストの上限判定・通知（T-14、F-29後半）は対象外。T-13への記録のみ行う
#   - チャンネル本体の投稿（A-11）のみが起動対象。スレッド返信（A-14）内の@メンションはこの
#     スライスでは対象外（次スライスでA-14にも同じ配線を追加する）
#
# トリガー: A-11で人間の発言本文に「@{persona_name}」の文字列一致が含まれ、かつ当該チャンネルの
# is_ai_enabled=trueのとき、非同期タスクとして起動する（8.1節・8.7節、REQ-N-05。A-11自体は
# 応答を待たずに投稿完了を返す）。AIへのメンションはID参照化の対象外（基本設計書5.22節
# 「設計判断」。チャンネルAIは1チャンネルにつき1つしかなく、同姓同名のような曖昧さが生じない）。
import asyncio
import traceback

from database import get_pool
from services import ai_client

MAX_HISTORY_MESSAGES = 200
TEMPERATURE = 0.5
MAX_OUTPUT_TOKENS = 1000

# 全チャンネル共通のシステム指示（基本設計書8.3節・詳細設計書10.2節）。チャンネル管理者は編集できず
# アプリ側で固定する。ドキュメント検索・座席予約が未実装であることも明示し、ハルシネーションで
# 「できる」と案内しないようにする（詳細設計書10.7節のハルシネーション防止確認observationに対応）。
FIXED_RULES = """# 全チャンネル共通ルール（固定・編集不可）
- 過去のやり取りを参照する場合は「参考情報」であることを必ず明示し、断定しない
- あなたには現時点で社内ドキュメントを検索する機能・座席予約システムを参照する機能が無い。
  それらの機能が必要な依頼を受けたときは、正直に「その機能はまだ利用できません」と答え、
  存在しない検索結果や空き状況を作り出さないこと
- 自分がAIであることを偽らない、あなたが実際に持たない機能を持っているかのように案内しない"""


def _build_system_prompt(settings: dict) -> str:
    persona_name = settings["persona_name"] or "AI"
    persona_tone = settings["persona_tone"] or "自然な日本語"
    behavior = (settings["behavior_prompt"] or "").strip()
    lines = [f'あなたは「{persona_name}」というチャンネルAIです。口調: {persona_tone}']
    if behavior:
        lines.append(behavior)
    lines.append("")
    lines.append(FIXED_RULES)
    return "\n".join(lines)


def detect_mention(body: str, persona_name: str) -> bool:
    """AIメンションの検知は本文中の「@ペルソナ名」の文字列一致のみ（ID参照化しない。
    基本設計書5.22節「設計判断」）。F-41のメンションピッカーの候補にはチャンネルAIを含めていない
    （このスライスでは対象外）ため、利用者は手入力で「@{persona_name}」と書く必要がある。"""
    return f"@{persona_name}" in body


async def _fetch_settings(channel_id: int) -> dict | None:
    row = await get_pool().fetchrow(
        "SELECT * FROM channel_ai_settings WHERE channel_id = $1", channel_id
    )
    return dict(row) if row else None


async def maybe_trigger(channel_id: int, body: str, requested_by: int) -> None:
    """A-11から呼ばれる。条件を満たせば非同期タスクとしてAI応答生成を起動する（fire-and-forget、
    REQ-N-05）。OPENAI_API_KEY未設定・AI無効・メンション無しのいずれかであれば何もしない。"""
    if not ai_client.is_configured():
        return
    settings = await _fetch_settings(channel_id)
    if settings is None or not settings["is_ai_enabled"]:
        return
    persona_name = settings["persona_name"] or "AI"
    if not detect_mention(body, persona_name):
        return
    asyncio.create_task(_generate_and_post(channel_id, settings, requested_by))


async def _generate_and_post(channel_id: int, settings: dict, requested_by: int) -> None:
    pool = get_pool()
    persona_name = settings["persona_name"] or "AI"
    persona_icon_url = settings["persona_icon_url"]

    # 生成中プレースホルダ（詳細設計書10.3節で確定した方式）。bot_display_name/bot_icon_urlを
    # BOT発言と同じ列に流用し、生成時点のペルソナ名・アイコンをスナップショットする
    # （後で設定が変わっても、この発言の表示は変わらない）
    placeholder = await pool.fetchrow(
        """INSERT INTO messages (channel_id, sender_type, body, generation_status,
               bot_display_name, bot_icon_url)
           VALUES ($1, 'ai', '', 'generating', $2, $3) RETURNING id""",
        channel_id, persona_name, persona_icon_url,
    )
    message_id = placeholder["id"]

    try:
        rows = await pool.fetch(
            """SELECT sender_type, sender_user_id, bot_display_name, body, created_at
               FROM messages
               WHERE channel_id = $1 AND deleted_at IS NULL AND thread_parent_id IS NULL
                 AND generation_status IS NULL
               ORDER BY created_at DESC LIMIT $2""",
            channel_id, MAX_HISTORY_MESSAGES,
        )
        history_rows = list(reversed(rows))

        # 発言者名の解決用にsender_user_idのnameだけ別途取得する（履歴の整形専用の軽い問い合わせ）
        user_ids = {r["sender_user_id"] for r in history_rows if r["sender_user_id"] is not None}
        names: dict[int, str] = {}
        if user_ids:
            for r in await pool.fetch(
                "SELECT id, name FROM users WHERE id = ANY($1::bigint[])", list(user_ids)
            ):
                names[r["id"]] = r["name"]

        messages: list[dict] = [{"role": "system", "content": _build_system_prompt(settings)}]
        for r in history_rows:
            if not r["body"]:
                continue
            if r["sender_type"] == "human":
                name = names.get(r["sender_user_id"], "利用者")
                messages.append({"role": "user", "content": f"{name}: {r['body']}"})
            elif r["sender_type"] == "ai":
                messages.append({"role": "assistant", "content": r["body"]})
            else:
                # BOT発言（定期投稿・トリガー）はAIの自己発言と混同しないよう利用者側の文脈として渡す
                messages.append({"role": "user", "content": f"{r['bot_display_name'] or 'BOT'}: {r['body']}"})

        client = ai_client.get_client()
        model = ai_client.get_model()
        res = await client.chat.completions.create(
            model=model, messages=messages,
            temperature=TEMPERATURE, max_completion_tokens=MAX_OUTPUT_TOKENS,
        )
        reply = (res.choices[0].message.content or "").strip() or "（回答を生成できませんでした）"

        await pool.execute(
            "UPDATE messages SET body = $2, generation_status = NULL WHERE id = $1",
            message_id, reply,
        )

        if res.usage:
            cost = ai_client.estimate_cost_yen(model, res.usage.prompt_tokens, res.usage.completion_tokens)
            await pool.execute(
                """INSERT INTO ai_usage_logs
                       (channel_id, requested_by, model, input_tokens, output_tokens, estimated_cost_yen)
                   VALUES ($1, $2, $3, $4, $5, $6)""",
                channel_id, requested_by, model,
                res.usage.prompt_tokens, res.usage.completion_tokens, cost,
            )
    except Exception:
        traceback.print_exc()
        await pool.execute(
            "UPDATE messages SET body = $2, generation_status = NULL WHERE id = $1",
            message_id, "（エラーが発生したため回答できませんでした）",
        )
