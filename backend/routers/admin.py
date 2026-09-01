# A-36〜A-44（詳細設計書 API設計4.8節、基本設計書3.3節・S-08管理コンソール）。
# 利用者管理（A-36/A-37）・ドキュメント参照範囲のフォルダ登録（A-38〜A-40、F-22）・
# AI利用状況・コスト（A-42/A-43、F-29）・監査ログ（A-44、T-16）を実装。
import re
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_helpers import CurrentUser, require_auth, require_roles
from database import get_pool

router = APIRouter(prefix="/api/admin", tags=["admin"])
JST = ZoneInfo("Asia/Tokyo")


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


def _month_range(month: str | None) -> tuple[datetime, datetime, str]:
    """month（YYYY-MM）省略時はJSTの当月を対象とする。開始（含む）〜終了（含まない）の
    UTC対応datetimeと、正規化したmonth文字列を返す"""
    if month:
        try:
            start_date = date.fromisoformat(f"{month}-01")
        except ValueError:
            raise HTTPException(422, detail="monthはYYYY-MM形式です")
    else:
        start_date = datetime.now(JST).date().replace(day=1)
    start = datetime.combine(start_date, time.min, tzinfo=JST)
    end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
    return start, end, f"{start_date.year:04d}-{start_date.month:02d}"


def _limit_out(row, used_cost_yen: float) -> dict:
    limit = float(row["monthly_limit_yen"])
    return {
        "monthly_limit_yen": limit,
        "notify_threshold_pct": row["notify_threshold_pct"],
        "notify_email": row["notify_email"],
        "used_pct": round(used_cost_yen / limit * 100, 1) if limit > 0 else 0.0,
    }


@router.get("/usage")
async def get_usage(month: str | None = None, user: CurrentUser = Depends(require_roles("admin"))):
    """A-42: AI利用状況・概算コストの月次集計（F-29）。T-13を月次・チャンネル別・利用者別に
    集計する（基本設計書8.6節「月次・チャンネル別・利用者別に集計して表示する」。05-2 API設計の
    レスポンス例はby_channelのみだったが、05-3画面設計「利用者別テーブル」の記載とあわせて
    by_userも追加した）。dm_idはAIのDM応答が未実装のため現状常に発生しない（by_channelのみ）。"""
    start, end, month_str = _month_range(month)
    pool = get_pool()

    total = await pool.fetchrow(
        """SELECT count(*) AS call_count, COALESCE(sum(estimated_cost_yen), 0) AS cost_yen
           FROM ai_usage_logs WHERE created_at >= $1 AND created_at < $2""",
        start, end,
    )
    by_channel_rows = await pool.fetch(
        """SELECT l.channel_id, c.name AS channel_name, count(*) AS call_count,
               sum(l.input_tokens) AS input_tokens, sum(l.output_tokens) AS output_tokens,
               sum(l.estimated_cost_yen) AS cost_yen
           FROM ai_usage_logs l
           LEFT JOIN channels c ON c.id = l.channel_id
           WHERE l.created_at >= $1 AND l.created_at < $2 AND l.channel_id IS NOT NULL
           GROUP BY l.channel_id, c.name
           ORDER BY cost_yen DESC""",
        start, end,
    )
    by_user_rows = await pool.fetch(
        """SELECT l.requested_by, u.name AS user_name, count(*) AS call_count,
               sum(l.input_tokens) AS input_tokens, sum(l.output_tokens) AS output_tokens,
               sum(l.estimated_cost_yen) AS cost_yen
           FROM ai_usage_logs l
           JOIN users u ON u.id = l.requested_by
           WHERE l.created_at >= $1 AND l.created_at < $2
           GROUP BY l.requested_by, u.name
           ORDER BY cost_yen DESC""",
        start, end,
    )
    limit_rows = await pool.fetch(
        """SELECT l.*, c.name AS channel_name FROM ai_usage_limits l
           LEFT JOIN channels c ON c.id = l.channel_id"""
    )

    total_cost = float(total["cost_yen"])
    channel_cost = {r["channel_id"]: float(r["cost_yen"]) for r in by_channel_rows}
    global_limit_row = next((r for r in limit_rows if r["scope"] == "global"), None)
    channel_limit_rows = [r for r in limit_rows if r["scope"] == "channel"]

    return {
        "month": month_str,
        "total_cost_yen": total_cost,
        "total_call_count": total["call_count"],
        "by_channel": [
            {
                "channel_id": str(r["channel_id"]),
                "channel_name": r["channel_name"],
                "call_count": r["call_count"],
                "input_tokens": r["input_tokens"],
                "output_tokens": r["output_tokens"],
                "cost_yen": float(r["cost_yen"]),
            }
            for r in by_channel_rows
        ],
        "by_user": [
            {
                "user_id": str(r["requested_by"]),
                "user_name": r["user_name"],
                "call_count": r["call_count"],
                "input_tokens": r["input_tokens"],
                "output_tokens": r["output_tokens"],
                "cost_yen": float(r["cost_yen"]),
            }
            for r in by_user_rows
        ],
        "limits": {
            "global": _limit_out(global_limit_row, total_cost) if global_limit_row else None,
            "channels": [
                {
                    "channel_id": str(r["channel_id"]),
                    "channel_name": r["channel_name"],
                    **_limit_out(r, channel_cost.get(r["channel_id"], 0.0)),
                }
                for r in channel_limit_rows
            ],
        },
    }


class UpdateUsageLimitRequest(BaseModel):
    scope: str
    channel_id: str | None = None
    monthly_limit_yen: float = Field(gt=0)
    notify_threshold_pct: int = Field(default=80, ge=1, le=100)
    notify_email: str = Field(min_length=1, max_length=200)


@router.put("/usage/limits")
async def update_usage_limit(body: UpdateUsageLimitRequest, user: CurrentUser = Depends(require_roles("admin"))):
    """A-43: 上限設定・通知先の更新（F-29）。scope='global'は常に1行、scope='channel'は
    channel_idごとに1行を洗い替える（05-1 DB設計3.11節の部分ユニークインデックスをON CONFLICTの
    対象にする）。80%到達時の通知メール送信・上限到達時の応答停止はこのスライスでは対象外
    （要件定義書8.2節のとおり上限到達時の挙動は千田氏との別途協議事項のため、設定の保存と
    使用率表示（A-42のused_pct）のみ行う）。"""
    if body.scope not in ("global", "channel"):
        raise HTTPException(422, detail="scopeはglobal/channelのいずれかです")
    pool = get_pool()
    if body.scope == "global":
        row = await pool.fetchrow(
            """INSERT INTO ai_usage_limits (scope, monthly_limit_yen, notify_threshold_pct, notify_email)
               VALUES ('global', $1, $2, $3)
               ON CONFLICT (scope) WHERE scope = 'global'
               DO UPDATE SET monthly_limit_yen = $1, notify_threshold_pct = $2, notify_email = $3, updated_at = now()
               RETURNING *""",
            body.monthly_limit_yen, body.notify_threshold_pct, body.notify_email,
        )
    else:
        if body.channel_id is None or not body.channel_id.isdigit():
            raise HTTPException(422, detail="scope='channel'の場合はchannel_idが必要です")
        channel_id = int(body.channel_id)
        exists = await pool.fetchval("SELECT EXISTS(SELECT 1 FROM channels WHERE id = $1)", channel_id)
        if not exists:
            raise HTTPException(404, detail="見つかりません")
        row = await pool.fetchrow(
            """INSERT INTO ai_usage_limits (scope, channel_id, monthly_limit_yen, notify_threshold_pct, notify_email)
               VALUES ('channel', $1, $2, $3, $4)
               ON CONFLICT (channel_id) WHERE scope = 'channel'
               DO UPDATE SET monthly_limit_yen = $2, notify_threshold_pct = $3, notify_email = $4, updated_at = now()
               RETURNING *""",
            channel_id, body.monthly_limit_yen, body.notify_threshold_pct, body.notify_email,
        )
    return {
        "scope": row["scope"],
        "channel_id": str(row["channel_id"]) if row["channel_id"] is not None else None,
        "monthly_limit_yen": float(row["monthly_limit_yen"]),
        "notify_threshold_pct": row["notify_threshold_pct"],
        "notify_email": row["notify_email"],
    }


AUDIT_PAGE_SIZE = 50


def _parse_date_param(value: str, field_name: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise HTTPException(422, detail=f"{field_name}はYYYY-MM-DD形式です")


@router.get("/audit-logs")
async def list_audit_logs(
    event_type: str | None = None,
    channel_id: str | None = None,
    actor_user_id: str | None = None,
    after: str | None = None,
    before: str | None = None,
    page: int = 1,
    user: CurrentUser = Depends(require_roles("admin")),
):
    """A-44: 監査ログ一覧（種別・期間・対象者で絞り込み。T-16、要件定義書7章「監査」）。
    afterは指定日を含む、beforeは指定日を含まない（当日いっぱいを対象にするにはbeforeへ翌日を
    指定する）。変更内容そのもの（過去バージョン・差分）は保持しないため、summaryは種類の説明のみ。"""
    conditions: list[str] = []
    params: list = []
    if event_type:
        if event_type not in ("login", "channel_ai_setting_change"):
            raise HTTPException(422, detail="event_typeはlogin/channel_ai_setting_changeのいずれかです")
        params.append(event_type)
        conditions.append(f"l.event_type = ${len(params)}")
    if channel_id:
        if not channel_id.isdigit():
            raise HTTPException(422, detail="channel_idは数値のIDです")
        params.append(int(channel_id))
        conditions.append(f"l.target_channel_id = ${len(params)}")
    if actor_user_id:
        if not actor_user_id.isdigit():
            raise HTTPException(422, detail="actor_user_idは数値のIDです")
        params.append(int(actor_user_id))
        conditions.append(f"l.actor_user_id = ${len(params)}")
    if after:
        params.append(datetime.combine(_parse_date_param(after, "after"), time.min, tzinfo=JST))
        conditions.append(f"l.created_at >= ${len(params)}")
    if before:
        params.append(datetime.combine(_parse_date_param(before, "before"), time.min, tzinfo=JST))
        conditions.append(f"l.created_at < ${len(params)}")

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    offset = max(page, 1) - 1
    rows = await get_pool().fetch(
        f"""SELECT l.id, l.event_type, l.actor_user_id, u.name AS actor_name,
                   l.target_channel_id, c.name AS target_channel_name, l.target_field, l.summary, l.created_at
            FROM audit_logs l
            JOIN users u ON u.id = l.actor_user_id
            LEFT JOIN channels c ON c.id = l.target_channel_id
            {where}
            ORDER BY l.created_at DESC
            LIMIT {AUDIT_PAGE_SIZE} OFFSET {offset * AUDIT_PAGE_SIZE}""",
        *params,
    )
    return {
        "items": [
            {
                "id": str(r["id"]),
                "event_type": r["event_type"],
                "actor_user_id": str(r["actor_user_id"]),
                "actor_name": r["actor_name"],
                "target_channel_id": str(r["target_channel_id"]) if r["target_channel_id"] is not None else None,
                "target_channel_name": r["target_channel_name"],
                "target_field": r["target_field"],
                "summary": r["summary"],
                "created_at": r["created_at"].isoformat(),
            }
            for r in rows
        ],
        "has_more": len(rows) == AUDIT_PAGE_SIZE,
    }
