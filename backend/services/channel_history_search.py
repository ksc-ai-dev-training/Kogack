# チャンネルAIが「直近の会話履歴（ai_agent.MAX_HISTORY_MESSAGES=20件）」の外側にある、もっと
# 古いやり取りを参照できるようにする機能（ユーザーからの明示的な要望「AIが今までのチャンネルの
# 会話を参照して回答できるようにしてほしい」）。ai_agent.pyのsearch_channel_historyツール
# （Function Calling）から呼ばれる。
#
# 着手前にユーザーへ設計を確認し、「普段は今までどおり直近の会話履歴のみを毎回送ってコストを
# 抑えたまま、AIが必要と判断したときだけこの検索ツールを使って過去の発言を遡る」方式（検索
# ツール追加案）を選んでもらった（MAX_HISTORY_MESSAGES自体を増やす案は、2026-09-02にユーザー
# 自身が「直近だけ送る」方針へ絞った経緯と逆行し、会話が長いチャンネルほど毎回のコストが
# 増え続けるため見送った）。doc_search.py（Slice 3、文書のembedding類似度検索）とは異なり、
# メッセージ本文にembeddingを持たせていないため、S-05横断検索（routers/search.py）と同じ
# pg_trgm（idx_messages_body_trgm）を使った素朴な部分一致（ILIKE）にとどめる。
from zoneinfo import ZoneInfo

from database import get_pool

JST = ZoneInfo("Asia/Tokyo")
MAX_RESULTS = 8  # 検索結果が多すぎるとその分トークンを消費するため、doc_search.TOP_K（5件）と
# 同程度の規模感で抑える（メッセージ本文はドキュメントのチャンクより短いことが多いため気持ち多め）


async def search(channel_id: int, query: str) -> list[dict]:
    """queryを本文に含む過去の発言を新しい順に検索し、古い順に並べ替えて返す（会話の流れとして
    読みやすくするため）。チャンネル本体・スレッド返信・システム通知/BOT/AI発言のいずれも対象に
    含める（「以前どんな話をしたか」という問いにはスレッド内の話題も関係しうるため、
    ai_agent._fetch_history_rowsのようなthread_parent_id IS NULLの絞り込みはしない）。
    **queryは空白区切りで複数語に分解し、すべての語を含む（AND、順序・隣接は問わない）発言を
    対象にする**（routers/search.pyの_parse_terms・_build_conditionsと同じ考え方）。
    AIが渡すqueryは「オフサイト 名前」のように自然文由来の複数語になりやすく、これを1つの
    連続した文字列として厳密一致（ILIKE '%クエリ全体%'）させると、実際のメッセージ本文の中で
    その語順・隣接関係のまま出現しないケースが大半でヒットしない（実機検証で発見・修正。
    「オフサイトの名前」という単一クエリでは実際の本文「オフサイトは...という名前で」に
    ヒットしなかったのに対し、「オフサイト」「名前」の2語ANDでは正しくヒットすることを確認した）。
    戻り値: [{sender_name, body, created_at（JSTのdatetime）}, ...]"""
    terms = query.split()
    if not terms:
        return []
    pool = get_pool()
    conditions = ["m.channel_id = $1", "m.deleted_at IS NULL", "m.generation_status IS NULL"]
    params: list = [channel_id]
    for term in terms:
        params.append(term)
        conditions.append(f"m.body ILIKE '%' || ${len(params)} || '%'")
    params.append(MAX_RESULTS)
    rows = await pool.fetch(
        f"""SELECT m.sender_type, m.bot_display_name, m.body, m.created_at, u.name AS sender_name
            FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id
            WHERE {' AND '.join(conditions)}
            ORDER BY m.created_at DESC
            LIMIT ${len(params)}""",
        *params,
    )
    results = []
    for r in rows:
        if r["sender_type"] == "human":
            name = r["sender_name"] or "利用者"
        elif r["sender_type"] == "ai":
            name = "AI"
        else:
            name = r["bot_display_name"] or "BOT"
        results.append({
            "sender_name": name,
            "body": r["body"],
            "created_at": r["created_at"].astimezone(JST),
        })
    return list(reversed(results))
