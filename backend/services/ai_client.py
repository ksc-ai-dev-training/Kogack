# OpenAI APIクライアント・コスト計算（詳細設計書AIサポート10.5〜10.6節）。姉妹プロジェクトKeireki
# のai_client.pyと責務は同じだが、使用モデルは環境変数AI_MODELのみで決定し、管理画面からの
# モデル切替機能は設けない（10.6節「Keirekiのような画面上でのモデル切替機能は設けない」。
# 意図的な相違点、CLAUDE.md参照）。単価は円/1000トークン（10.5節の単価表をそのまま採用）。
import os

from openai import AsyncOpenAI

from database import ROOT_ENV

DEFAULT_MODEL = "gpt-4o-mini"

# 1000トークンあたりの単価（円）。実際の契約プランに応じて調整する想定（10.5節の例をそのまま採用）。
# 未知のモデルは既定モデルの単価で概算する。各行はOpenAI公表のUSD単価（1Mトークンあたり）を
# gpt-4o-miniの行と同じ換算レート（約153.33円/USD、既存の0.023円/0.092円から逆算した値）で
# 円/1000トークンへ換算している（レートを行ごとに変えると単価表内で整合しなくなるため統一する）
MODEL_COSTS = {
    "gpt-4o-mini": {"input": 0.023, "output": 0.092},
    # gpt-5-nano: $0.05/$0.40（1Mトークン、USD）。ローカル動作確認用に最安のテキスト生成モデルとして採用
    # （2026-09-02時点のOpenAI公式単価、developers.openai.com/api/docs/pricing）
    "gpt-5-nano": {"input": 0.0077, "output": 0.0613},
}


def _env(key: str, default: str = "") -> str:
    """環境変数優先でルート.envを読む（database.pyと同じ規約）"""
    return os.environ.get(key) or ROOT_ENV.get(key, default)


def is_configured() -> bool:
    """APIキーが設定されているか。未設定ならAIサポートは無効（S-06 AI設定タブ等の表示制御に使う）"""
    return bool(_env("OPENAI_API_KEY"))


def get_model() -> str:
    return _env("AI_MODEL", DEFAULT_MODEL)


# reasoning系モデル（gpt-5-nano等）はChat Completions APIで`reasoning_effort`を指定しないと、
# 内部の思考にreasoning_tokensを使い切ってmax_completion_tokensに達し、応答本文が空のまま
# finish_reason='length'で返ってくることを実機検証で確認した（トークンはreasoning_tokensとして
# 消費済みのため課金は発生する）。逆に非reasoningモデル（gpt-4o-mini等）に`reasoning_effort`を
# 渡すと「Unrecognized request argument」で400エラーになるため、無条件には指定できない
REASONING_MODELS = {"gpt-5-nano"}


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
