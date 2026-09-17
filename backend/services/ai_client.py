# OpenAI APIクライアント・コスト計算（詳細設計書AIサポート10.5〜10.6節）。姉妹プロジェクトKeireki
# のai_client.pyと責務は同じだが、単価は円/1000トークン（10.5節の単価表をそのまま採用）。
# **2026-09-17にユーザーからの明示的な要望でチャンネルごとのモデル選択機能を追加した**（従来は
# AI_MODEL環境変数のみで一律決定し、Keirekiのような画面上でのモデル切替機能は設けない、という
# 意図的な相違点だったが、この方針を反転した。詳細は10.6節・CLAUDE.md参照）。ただしKeirekiの
# app_settingsのようなグローバル1設定ではなく、既存のchannel_ai_settings（T-08）へ
# ai_model列を追加する形の**チャンネルごと**の設定にした（persona_name等の既存の
# チャンネル単位AI設定と一貫させるため）。resolve_model()参照。
import os

from openai import AsyncOpenAI

from database import ROOT_ENV

# 2026-09-17（続報）: ユーザーからの明示的な要望「速度は遅くなってもかまわないので、
# 高性能なものにしましょう」を受け、既定モデルをgpt-4.1-nanoから、現時点でMODEL_COSTSに
# ある中で最も高性能なgpt-5-miniへ変更した。このセッションで繰り返し発生した「小型モデルが
# 複数の複雑な指示を同時に守れない」不具合群（招待リンク・チャンネル名・口調固定等）への
# 根本対応の一環。DEFAULT_MODELは未知モデルのコスト概算フォールバック先
# （MODEL_COSTS[DEFAULT_MODEL]）としても使われるため、必ずMODEL_COSTSに存在するキーに
# 保つ必要がある
DEFAULT_MODEL = "gpt-5-mini"

# 1000トークンあたりの単価（円）。実際の契約プランに応じて調整する想定（10.5節の例をそのまま採用）。
# 未知のモデルは既定モデルの単価で概算する。各行はOpenAI公表のUSD単価（1Mトークンあたり）を
# 統一の換算レート（約153.33円/USD、2026-09-02時点のgpt-4o-mini行0.023円/0.092円から逆算した値。
# gpt-4o-mini自体は2026-09-17に選択肢から除外したがレートの基準としては引き続き使う）で
# 円/1000トークンへ換算している（レートを行ごとに変えると単価表内で整合しなくなるため統一する）
MODEL_COSTS = {
    # gpt-5-nano: $0.05/$0.40（1Mトークン、USD）。ローカル動作確認用に最安のテキスト生成モデルとして採用
    # （2026-09-02時点のOpenAI公式単価、developers.openai.com/api/docs/pricing）
    "gpt-5-nano": {"input": 0.0077, "output": 0.0613},
    # gpt-4.1-nano: $0.10/$0.40（1Mトークン、USD）。gpt-5-nanoは推論系モデルでreasoning_tokensの
    # 分だけ応答が遅くなることが本番実機で判明したため、2026-09-04に非推論系のこちらへ切り替えた
    # （gpt-4o-miniより安価かつコンテキスト長も大きい。2026-09-04時点のOpenAI公式単価）
    "gpt-4.1-nano": {"input": 0.0153, "output": 0.0613},
    # gpt-4.1-mini: $0.40/$1.60（1Mトークン、USD）。ユーザーからの明示的な要望「gpt-4.1-nanoより
    # 高性能な選択肢が欲しい」への対応で追加した（S-06基本設定タブのモデル選択、2026-09-17）。
    # gpt-4.1-nanoとgpt-4.1（フル版、$2.00/$8.00）のちょうど中間の性能・単価帯（2026-09-17時点の
    # OpenAI公式単価、developers.openai.com/api/docs/pricing）
    "gpt-4.1-mini": {"input": 0.0613, "output": 0.2453},
    # gpt-5-mini: $0.25/$2.00（1Mトークン、USD）。ユーザーからの明示的な要望「4o-miniを除外して
    # 5-miniを追加してほしい」への対応（2026-09-17）。gpt-5-nanoと同じGPT-5系の推論モデルのため
    # REASONING_MODELSにも追加する（下記）。gpt-4o-mini（$0.15/$0.60）は同じユーザー要望により
    # 選択肢から除外した（実際の応答品質・速度でgpt-4.1-nano系に劣ると判断されたため）。
    "gpt-5-mini": {"input": 0.0383, "output": 0.3067},
}

# S-06基本設定タブのドロップダウンに表示する、各モデルの簡潔な特徴の説明（ユーザーからの明示的な
# 要望「コスト・速度・性能の簡潔でわかりやすい説明を入れてほしい」、2026-09-17）。選択の判断材料
# であって厳密なベンチマーク値ではないため、断定的な性能比較ではなく用途の目安として書く。
MODEL_DESCRIPTIONS = {
    "gpt-4.1-nano": "速度・コストを最優先したいときに。応答品質は他の選択肢より劣る",
    "gpt-5-nano": "推論系。複雑な多段階の論理・計算問題には強いが、応答はやや遅い",
    "gpt-4.1-mini": "gpt-4.1-nanoより高性能。非推論系のため速度は保ちつつ応答の質を上げたいときに",
    "gpt-5-mini": "現在の既定。推論系で最も高性能だが、応答は遅めでコストも高い",
}


def _env(key: str, default: str = "") -> str:
    """環境変数優先でルート.envを読む（database.pyと同じ規約）"""
    return os.environ.get(key) or ROOT_ENV.get(key, default)


def is_configured() -> bool:
    """APIキーが設定されているか。未設定ならAIサポートは無効（S-06 AI設定タブ等の表示制御に使う）"""
    return bool(_env("OPENAI_API_KEY"))


def get_model() -> str:
    return _env("AI_MODEL", DEFAULT_MODEL)


def resolve_model(channel_model: str | None) -> str:
    """チャンネルのai_model（channel_ai_settings.ai_model）を返す。2026-09-17にDBを
    NOT NULL DEFAULT 'gpt-4.1-nano'へ変更したため通常は常に値が入っているが、念のため
    NULL・空文字の場合はAI_MODEL環境変数の既定値へフォールバックする防御的な実装のまま
    残す。services/ai_agent.pyの実際にAPIを呼ぶ2箇所（_generate_and_post・
    _generate_summary_and_post）で使う"""
    return channel_model or get_model()


def selectable_models() -> list[str]:
    """S-06基本設定タブのモデル選択肢。MODEL_COSTSのキー集合をそのまま返す（新しいモデルの
    単価行を追加すれば自動的に選択肢にも現れる、DBのCHECK制約では縛らない設計と対）"""
    return list(MODEL_COSTS.keys())


# reasoning系モデル（gpt-5-nano等）はChat Completions APIで`reasoning_effort`を指定しないと、
# 内部の思考にreasoning_tokensを使い切ってmax_completion_tokensに達し、応答本文が空のまま
# finish_reason='length'で返ってくることを実機検証で確認した（トークンはreasoning_tokensとして
# 消費済みのため課金は発生する）。逆に非reasoningモデル（gpt-4.1-nano等）に`reasoning_effort`を
# 渡すと「Unrecognized request argument」で400エラーになるため、無条件には指定できない。
# gpt-5-mini（2026-09-17追加）もgpt-5-nanoと同じGPT-5系の推論モデルのため同じ扱いが必要
REASONING_MODELS = {"gpt-5-nano", "gpt-5-mini"}


def is_reasoning_model(model: str) -> bool:
    return model in REASONING_MODELS


def get_client() -> AsyncOpenAI:
    api_key = _env("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY が設定されていません")
    # 応答が遅いときにリクエストを溜め込まないよう、SDK既定（600秒）より短くする
    return AsyncOpenAI(api_key=api_key, timeout=60.0, max_retries=1)


def estimate_cost_yen(model: str, input_tokens: int, output_tokens: int) -> float:
    rate = MODEL_COSTS.get(model, MODEL_COSTS[DEFAULT_MODEL])
    return round(input_tokens / 1000 * rate["input"] + output_tokens / 1000 * rate["output"], 4)


# 層2ドキュメントQ&A（Slice 3、2026-09-09）の埋め込み生成に使うモデル。応答生成用モデル
# （AI_MODEL環境変数）とは独立で固定する（利用者が切り替える対象ではなく、doc_chunks.embedding
# のvector(1536)次元と直結しているため、切り替えるとテーブル定義ごと変更が必要になる）。
EMBEDDING_MODEL = "text-embedding-3-small"
_EMBEDDING_COST_PER_1K = 0.0031  # $0.02/1Mトークン（2026-09-09時点のOpenAI公式単価）を同じ換算レートで円/1000トークンへ


def estimate_embedding_cost_yen(tokens: int) -> float:
    return round(tokens / 1000 * _EMBEDDING_COST_PER_1K, 4)


async def embed_texts(texts: list[str]) -> tuple[list[list[float]], int]:
    """textsをまとめて埋め込みベクトル化する（OpenAI Embeddings APIは1リクエストで複数件を
    受け付けるため、チャンク数分のリクエストを個別に投げない）。戻り値は
    (各テキストに対応するベクトルのリスト, 消費トークン数)。"""
    client = get_client()
    res = await client.embeddings.create(model=EMBEDDING_MODEL, input=texts)
    vectors = [d.embedding for d in res.data]
    return vectors, res.usage.total_tokens
