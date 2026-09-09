# 層2参照ドキュメントの閲覧権限モデル（Slice 2b、2026-09-09。ユーザーと合意した設計。
# CLAUDE.md実装状況節を参照）。関係する3箇所（S-08フォルダの閲覧者編集、S-06参照範囲への追加、
# 非公開チャンネルへの新規招待）で共通して使う判定・強制退出ロジックをここへ集約する。
#
# 設計の要点:
#   - 限定公開フォルダ（doc_folders.is_restricted=true）は、doc_folder_viewersに列挙された
#     利用者のみが閲覧できる。全社公開（is_restricted=false）のフォルダは誰でも対象にできる。
#   - 公開チャンネルの参照範囲には全社公開フォルダしか追加できない（ハードブロック、確認不可）。
#   - 非公開チャンネルは限定公開フォルダも追加できるが、参加者全員が閲覧権限を持っている必要がある。
#     権限のない参加者がいる場合は、その参加者を名指しした確認の上でのみ強制退出させて追加できる
#     （force=Trueで実行）。
#   - 非公開チャンネルへの新規招待時も、既に設定されている全参照フォルダの閲覧権限を確認し、
#     権限が無ければ招待そのものを拒否する（参加はブロックのみ、強制はできない）。
#   - 強制退出の対象が「そのチャンネルの最後の管理者」の場合は、既存の安全策（A-48/A-72/A-73）と
#     同じく操作自体を拒否する。


class LastAdminConflict(Exception):
    """強制退出させようとした相手が、対象チャンネルの最後の管理者だった場合。"""

    def __init__(self, channel_id: int, channel_name: str, user_id: int, user_name: str):
        self.channel_id = channel_id
        self.channel_name = channel_name
        self.user_id = user_id
        self.user_name = user_name
        super().__init__(f"channel {channel_id} last admin {user_id}")


async def is_restricted(conn, folder_id: int) -> bool:
    return bool(await conn.fetchval("SELECT is_restricted FROM doc_folders WHERE id = $1", folder_id))


async def members_missing_access(conn, channel_id: int, folder_id: int) -> list[dict]:
    """指定チャンネルの参加者のうち、指定フォルダ（全社公開なら空リスト）を閲覧できない利用者。"""
    if not await is_restricted(conn, folder_id):
        return []
    rows = await conn.fetch(
        """SELECT u.id, u.name FROM channel_members cm
           JOIN users u ON u.id = cm.user_id
           WHERE cm.channel_id = $1
             AND NOT EXISTS (
                 SELECT 1 FROM doc_folder_viewers dfv
                 WHERE dfv.folder_id = $2 AND dfv.user_id = cm.user_id
             )
           ORDER BY u.name""",
        channel_id, folder_id,
    )
    return [{"id": str(r["id"]), "name": r["name"]} for r in rows]


async def folders_user_cannot_view(conn, channel_id: int, user_id: int) -> list[dict]:
    """指定チャンネルが参照範囲に持つ限定公開フォルダのうち、指定利用者が閲覧権限を持たないもの
    （A-08招待時に使用。(7)。公開チャンネルは限定公開フォルダを持てないため実質的に非公開
    チャンネルへの招待時のみ意味を持つが、汎用性のため channel_id を渡すだけで判定できるようにする）。
    [{folder_id, folder_name}, ...]"""
    rows = await conn.fetch(
        """SELECT f.id, f.drive_folder_name FROM channel_doc_folders cdf
           JOIN doc_folders f ON f.id = cdf.folder_id
           WHERE cdf.channel_id = $1 AND f.is_restricted
             AND NOT EXISTS (
                 SELECT 1 FROM doc_folder_viewers dfv
                 WHERE dfv.folder_id = f.id AND dfv.user_id = $2
             )""",
        channel_id, user_id,
    )
    return [{"folder_id": str(r["id"]), "folder_name": r["drive_folder_name"]} for r in rows]


async def channels_missing_access_for_folder(conn, folder_id: int, new_viewer_ids: set[int]) -> list[dict]:
    """フォルダの閲覧者リストをnew_viewer_idsへ変更した場合に、既にこのフォルダを参照している
    チャンネルの中で新たに閲覧権限を失う参加者がいれば、チャンネルごとにまとめて返す
    （S-08でのフォルダ閲覧者編集時に使用。is_restricted自体をtrueへ変更する場合も同様に扱える
    ようnew_viewer_idsは呼び出し元が最終状態として渡す）。
    [{channel_id, channel_name, members: [{id, name}]}, ...]"""
    channels = await conn.fetch(
        """SELECT c.id, c.name FROM channel_doc_folders cdf
           JOIN channels c ON c.id = cdf.channel_id
           WHERE cdf.folder_id = $1""",
        folder_id,
    )
    result = []
    for ch in channels:
        members = await conn.fetch(
            "SELECT u.id, u.name FROM channel_members cm JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = $1",
            ch["id"],
        )
        missing = [{"id": str(m["id"]), "name": m["name"]} for m in members if m["id"] not in new_viewer_ids]
        if missing:
            result.append({"channel_id": str(ch["id"]), "channel_name": ch["name"], "members": missing})
    return result


async def check_last_admin_conflicts(conn, removals: list[tuple[int, int]]) -> list[dict]:
    """(channel_id, user_id)のリストについて、その利用者がそのチャンネルの最後の管理者であれば
    衝突として返す（強制退出を実行する直前に必ず呼ぶ。1件でも衝突があれば操作全体を拒否する）。
    [{channel_id, channel_name, user_id, user_name}, ...]"""
    conflicts = []
    for channel_id, user_id in removals:
        is_admin = await conn.fetchval(
            "SELECT is_channel_admin FROM channel_members WHERE channel_id = $1 AND user_id = $2",
            channel_id, user_id,
        )
        if not is_admin:
            continue
        admin_count = await conn.fetchval(
            "SELECT count(*) FROM channel_members WHERE channel_id = $1 AND is_channel_admin", channel_id
        )
        if admin_count <= 1:
            channel_name = await conn.fetchval("SELECT name FROM channels WHERE id = $1", channel_id)
            user_name = await conn.fetchval("SELECT name FROM users WHERE id = $1", user_id)
            conflicts.append(
                {"channel_id": str(channel_id), "channel_name": channel_name, "user_id": str(user_id), "user_name": user_name}
            )
    return conflicts


async def force_remove_member(conn, channel_id: int, user_id: int) -> None:
    """A-73（remove_channel_member）と同じ強制退出処理（最後の管理者チェック抜き。呼び出し前に
    check_last_admin_conflictsで確認済みである前提）。F-43退出通知・F-17引き継ぎ先のNULL化も
    A-73と同じくここで行う。呼び出し元のトランザクション内で使うことを想定（conn引数を受け取る）。"""
    target_name = await conn.fetchval("SELECT name FROM users WHERE id = $1", user_id)
    await conn.execute("DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2", channel_id, user_id)
    await conn.execute(
        "UPDATE channel_ai_settings SET fallback_handoff_user_id = NULL WHERE channel_id = $1 AND fallback_handoff_user_id = $2",
        channel_id, user_id,
    )
    await conn.execute(
        "INSERT INTO messages (channel_id, sender_type, bot_display_name, body) VALUES ($1, 'bot', 'システム通知', $2)",
        channel_id, f"{target_name} さんが退出しました。",
    )
