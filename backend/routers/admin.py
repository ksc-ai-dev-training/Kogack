# A-36〜A-40（詳細設計書 API設計4.8節、基本設計書3.3節・S-08管理コンソール）。
# 利用者管理（A-36/A-37）・ドキュメント参照範囲のフォルダ登録（A-38〜A-40、F-22）を実装。
# AI利用状況・監査ログの2タブはAI呼び出し・監査ログ基盤が未実装のため対象外（CLAUDE.md 実装状況節）。
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_helpers import CurrentUser, require_auth, require_roles
from database import get_pool

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/users")
async def list_users(user: CurrentUser = Depends(require_roles("admin"))):
    """A-36: 利用者一覧。chadmin_channelsは参考表示のみ（変更はS-06チャンネル管理者タブで行う）"""
    rows = await get_pool().fetch(
        """SELECT u.id, u.name, u.email, u.picture_url, u.role, u.is_active, u.last_login_at,
               COALESCE(array_agg(c.name ORDER BY c.name) FILTER (WHERE cm.is_channel_admin), '{}')
                   AS chadmin_channels
           FROM users u
           LEFT JOIN channel_members cm ON cm.user_id = u.id AND cm.is_channel_admin
           LEFT JOIN channels c ON c.id = cm.channel_id
           GROUP BY u.id
           ORDER BY u.name"""
    )
    return {
        "items": [
            {
                "id": str(r["id"]), "name": r["name"], "email": r["email"],
                "picture_url": r["picture_url"], "role": r["role"],
                "is_active": r["is_active"],
                "last_login_at": r["last_login_at"].isoformat() if r["last_login_at"] else None,
                "chadmin_channels": list(r["chadmin_channels"]),
            }
            for r in rows
        ]
    }


class UpdateUserRequest(BaseModel):
    role: str | None = None
    is_active: bool | None = None


@router.put("/users/{target_id}")
async def update_user(
    target_id: int, body: UpdateUserRequest, user: CurrentUser = Depends(require_roles("admin")),
):
    """A-37: ロール変更・有効/無効化。自分自身の無効化・adminからの降格は管理者ロックアウト防止のため拒否する"""
    if body.role is not None and body.role not in ("member", "admin"):
        raise HTTPException(422, detail="roleはmember/adminのいずれかです")
    if target_id == user.id and body.is_active is False:
        raise HTTPException(400, detail="自分自身を無効化することはできません")
    if target_id == user.id and body.role == "member":
        raise HTTPException(400, detail="自分自身をmemberに降格することはできません")

    pool = get_pool()
    exists = await pool.fetchval("SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)", target_id)
    if not exists:
        raise HTTPException(404, detail="見つかりません")

    if body.role is not None:
        await pool.execute("UPDATE users SET role = $2, updated_at = now() WHERE id = $1", target_id, body.role)
    if body.is_active is not None:
        await pool.execute(
            "UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1", target_id, body.is_active
        )

    row = await pool.fetchrow("SELECT id, role, is_active FROM users WHERE id = $1", target_id)
    return {"id": str(row["id"]), "role": row["role"], "is_active": row["is_active"]}


_DRIVE_FOLDER_URL_RE = re.compile(r"drive\.google\.com/(?:drive/)?(?:u/\d+/)?folders/([a-zA-Z0-9_-]+)")


def _extract_folder_id(raw: str) -> str:
    """DriveのフォルダURL（https://drive.google.com/drive/folders/<ID>等）が貼り付けられた場合は
    IDを抽出する。画面設計8.2節が想定するGoogle Picker連携はDrive OAuthスコープ拡張が前提のため
    次スライスに持ち越し、このスライスはURL・IDいずれかの手動貼り付けを受け付ける簡易フォームとする。"""
    raw = raw.strip()
    m = _DRIVE_FOLDER_URL_RE.search(raw)
    return m.group(1) if m else raw


def _doc_folders_query(where: str = "") -> str:
    return f"""
        SELECT f.id, f.drive_folder_id, f.drive_folder_name, f.created_at,
               u.name AS added_by_name,
               COUNT(cdf.channel_id) AS channel_count
        FROM doc_folders f
        JOIN users u ON u.id = f.added_by
        LEFT JOIN channel_doc_folders cdf ON cdf.folder_id = f.id
        {where}
        GROUP BY f.id, u.name
        ORDER BY f.created_at
    """


def _doc_folder_out(row) -> dict:
    return {
        "id": str(row["id"]),
        "drive_folder_id": row["drive_folder_id"],
        "drive_folder_name": row["drive_folder_name"],
        "added_by_name": row["added_by_name"],
        "channel_count": row["channel_count"],
        "created_at": row["created_at"].isoformat(),
    }


@router.get("/doc-folders")
async def list_doc_folders(user: CurrentUser = Depends(require_auth)):
    """A-38: 参照ドキュメントフォルダ候補の一覧（F-22）。設計時はadmin限定だったが、S-06の
    「参照ドキュメント範囲」タブ（A-27、当該chadminも操作可）でチャンネル管理者がここから選択
    できる必要があるため、閲覧のみadminからrequire_auth（認証済み全員）に広げた（基本設計書
    6.2節「設計判断」）。フォルダ名・登録者名・使用中チャンネル数のみでチャンネル名等の非公開
    情報は含まないため、閲覧を広げても情報漏えいにはならない。登録・削除（A-39/A-40）は
    引き続きadmin限定。channel_countは削除前の目安として参考表示する（使用中でも確認なく
    削除できる。索引・AI検索が未実装のこのスライスでは実害が無い）"""
    rows = await get_pool().fetch(_doc_folders_query())
    return {"items": [_doc_folder_out(r) for r in rows]}


class CreateDocFolderRequest(BaseModel):
    drive_folder_id: str = Field(min_length=1, max_length=300)
    drive_folder_name: str = Field(min_length=1, max_length=200)


@router.post("/doc-folders", status_code=201)
async def create_doc_folder(body: CreateDocFolderRequest, user: CurrentUser = Depends(require_roles("admin"))):
    """A-39: フォルダ候補の追加"""
    folder_id = _extract_folder_id(body.drive_folder_id)
    if not folder_id:
        raise HTTPException(422, detail="フォルダのURLまたはIDを入力してください")
    pool = get_pool()
    exists = await pool.fetchval("SELECT EXISTS(SELECT 1 FROM doc_folders WHERE drive_folder_id = $1)", folder_id)
    if exists:
        raise HTTPException(409, detail="このフォルダは既に登録されています")
    new_id = await pool.fetchval(
        "INSERT INTO doc_folders (drive_folder_id, drive_folder_name, added_by) VALUES ($1, $2, $3) RETURNING id",
        folder_id, body.drive_folder_name.strip(), user.id,
    )
    row = await pool.fetchrow(_doc_folders_query("WHERE f.id = $1"), new_id)
    return _doc_folder_out(row)


@router.delete("/doc-folders/{folder_id}", status_code=204)
async def delete_doc_folder(folder_id: int, user: CurrentUser = Depends(require_roles("admin"))):
    """A-40: フォルダ候補の削除。使用中のチャンネル（T-10）があってもそのまま削除する
    （ON DELETE CASCADEでchannel_doc_foldersの割当も連動削除される）"""
    deleted = await get_pool().fetchval("DELETE FROM doc_folders WHERE id = $1 RETURNING id", folder_id)
    if deleted is None:
        raise HTTPException(404, detail="見つかりません")
