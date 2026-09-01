# T-16 audit_logs（監査ログ、S-08「監査ログ」タブ）への書き込み共通処理。
# 「いつ・誰が・どの項目を」変更したかのみを記録し、変更後の実際の値・差分は含めない
# （05-1_詳細設計書_DB設計.html 3.12節「本文差分は保持しない」）。呼び出し元は
# routers/auth.py（event_type='login'）とrouters/ai_settings.py（'channel_ai_setting_change'）。


async def record(
    conn,
    event_type: str,
    actor_user_id: int,
    summary: str,
    target_channel_id: int | None = None,
    target_field: str | None = None,
) -> None:
    await conn.execute(
        """INSERT INTO audit_logs (event_type, actor_user_id, target_channel_id, target_field, summary)
           VALUES ($1, $2, $3, $4, $5)""",
        event_type, actor_user_id, target_channel_id, target_field, summary,
    )
