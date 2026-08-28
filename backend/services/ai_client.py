# OpenAI APIクライアント・コスト計算（詳細設計書AIサポート10.5〜10.6節）。姉妹プロジェクトKeireki
# のai_client.pyと責務は同じだが、使用モデルは環境変数AI_MODELのみで決定し、管理画面からの
# モデル切替機能は設けない（10.6節「Keirekiのような画面上でのモデル切替機能は設けない」。
# 意図的な相違点、CLAUDE.md参照）。単価は円/1000トークン（10.5節の単価表をそのまま採用）。
import os

from openai import AsyncOpenAI

from database import ROOT_ENV

DEFAULT_MODEL = "gpt-4o-mini"

# 1000トークンあたりの単価（円）。実際の契約プランに応じて調整する想定（10.5節の例をそのまま採用）。
# 未知のモデルは既定モデルの単価で概算する
MODEL_COSTS = {
    "gpt-4o-mini": {"input": 0.023, "output": 0.092},
}


def _env(key: str, default: str = "") -> str:
    """環境変数優先でルート.envを読む（database.pyと同じ規約）"""
    return os.environ.get(key) or ROOT_ENV.get(key, default)


def is_configured() -> bool:
    """APIキーが設定されているか。未設定ならAIサポートは無効（S-06 AI設定タブ等の表示制御に使う）"""
    return bool(_env("OPENAI_API_KEY"))


def get_model() -> str:
    return _env("AI_MODEL", DEFAULT_MODEL)


def get_client() -> AsyncOpenAI:
    api_key = _env("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY が設定されていません")
    # 応答が遅いときにリクエストを溜め込まないよう、SDK既定（600秒）より短くする
    return AsyncOpenAI(api_key=api_key, timeout=60.0, max_retries=1)


def estimate_cost_yen(model: str, input_tokens: int, output_tokens: int) -> float:
    rate = MODEL_COSTS.get(model, MODEL_COSTS[DEFAULT_MODEL])
    return round(input_tokens / 1000 * rate["input"] + output_tokens / 1000 * rate["output"], 4)
