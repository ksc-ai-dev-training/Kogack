# fire-and-forgetのasyncioタスク起動の共通処理（2026-09-29バグ修正）。
# asyncio.create_task()の戻り値をどこにも保持しないと、イベントループはタスクへの弱参照しか
# 持たないため、実行途中のタスクがガベージコレクションされて黙って消えることがある（Python公式
# ドキュメントの注意事項）。AI応答生成・要約・Web Push送信・ドキュメント索引化はいずれも
# 投稿APIをブロックしないよう戻り値を捨てて起動していたため、まれに「生成中のまま止まる」
# 「通知が届かない」原因になりえた。完了するまでモジュール内の集合で強参照を持ち続ける。
import asyncio
from collections.abc import Coroutine

_tasks: set[asyncio.Task] = set()


def spawn(coro: Coroutine) -> asyncio.Task:
    """asyncio.create_taskと同じだが、完了するまでタスクへの参照を保持する"""
    task = asyncio.create_task(coro)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return task
