# 層2ドキュメントQ&A（F-19〜F-22）向け、Google Driveアクセストークンの取得・自動更新
# （T-23 google_drive_tokens）。2026-09-07、GCP側のDrive API有効化・スコープの全社展開について
# 千田氏の許可を得て着手した最初のスライス。索引作成・埋め込みベクトル化・検索本体は次のスライス。
from datetime import datetime, timedelta, timezone

import google_auth
from database import get_pool

# access_tokenの実際の失効時刻ちょうどまで使うと、リクエスト中に切れる可能性があるため、
# この秒数だけ前倒しで「期限切れ」とみなし、余裕を持って更新する
EXPIRY_BUFFER_SECONDS = 300


class DriveNotConnectedError(Exception):
    """当該利用者がまだDrive連携の同意をしていない（T-23に行が無い）場合"""


async def get_valid_access_token(user_id: int) -> str:
    """呼び出し時点で有効なaccess_tokenを返す。期限切れ間近ならrefresh_tokenで更新してから返す。

    実際のDrive APIへのリクエストはこの関数が返したトークンをAuthorizationヘッダーに
    そのまま使う想定（次のスライスで実装するDriveファイル一覧・内容取得から利用する）。
    """
    pool = get_pool()
    row = await pool.fetchrow(
        "SELECT access_token, refresh_token, expires_at FROM google_drive_tokens WHERE user_id = $1",
        user_id,
    )
    if row is None:
        raise DriveNotConnectedError("この利用者はまだGoogle Drive連携の同意をしていません")

    if row["expires_at"] > datetime.now(timezone.utc) + timedelta(seconds=EXPIRY_BUFFER_SECONDS):
        return row["access_token"]

    if not row["refresh_token"]:
        # refresh_tokenが無いまま期限切れになった場合、更新する手段が無いため再ログインしてもらうしかない
        raise DriveNotConnectedError(
            "Google Driveのアクセストークンが期限切れで、更新用のトークンもありません。再ログインしてください"
        )

    refreshed = await google_auth.refresh_access_token(row["refresh_token"])
    new_access_token = refreshed["access_token"]
    expires_in = int(refreshed.get("expires_in") or 3600)
    new_expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)
    await pool.execute(
        "UPDATE google_drive_tokens SET access_token = $2, expires_at = $3, updated_at = now() WHERE user_id = $1",
        user_id, new_access_token, new_expires_at,
    )
    return new_access_token
