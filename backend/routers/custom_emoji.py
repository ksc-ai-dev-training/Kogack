# カスタム絵文字（T-28 custom_emoji、要件定義書上のF-xxに対応付けられていない新規機能）。
# ユーザーからの明示的な要望「Slackみたいに、リアクションスタンプ（絵文字）を自分で作成できる
# 機能が欲しい」を受け、着手前に「誰が作成できるか」「どこで使えるか」を確認し、利用者全員が
# 作成可能・リアクション＋メッセージ本文の両方で使える、という仕様で合意した。
#
# 画像本体のアップロードは既存の汎用アップロードAPI（A-61 POST /api/icons）をフロント側から
# そのまま再利用する想定（Supabase Storage ICON_BUCKET・ローカル開発時のディスク保存フォールバック
# を含めて既に動作確認済みのコードを流用し、このモジュールでは重複実装しない）。このルーターは
# 「name（ショートコード）→image_url」の対応付けのみを扱う。
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from auth_helpers import CurrentUser, require_auth
from database import get_pool

router = APIRouter(prefix="/api/custom-emoji", tags=["custom-emoji"])

# ショートコード（:name: のnameの部分）の妥当性チェック。コロン自体はこの中に含められない
# （本文中で`:name:`と書いたときの開始・終了の区切り文字と衝突するため）。英数字・アンダースコア・
# ハイフンのみに限定し、標準的な絵文字ショートコード（Slack・GitHub等）の慣習に合わせる。
_NAME_RE = re.compile(r"^[a-zA-Z0-9_+-]{2,24}$")


def _out(row) -> dict:
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "image_url": row["image_url"],
        "created_by_name": row["created_by_name"],
        "created_at": row["created_at"].isoformat(),
    }


@router.get("")
async def list_custom_emoji(user: CurrentUser = Depends(require_auth)):
    """登録済みカスタム絵文字の一覧。Slackと同じくワークスペース（Kogack全体）で共有され、
    全チャンネル・全DMのリアクション・メッセージ本文で使える。認証済みであれば誰でも取得できる
    （画像自体もアイコンと同じくPublicバケットで、一覧を返すこと自体に機密性は無い）。"""
    rows = await get_pool().fetch(
        """SELECT e.id, e.name, e.image_url, e.created_at, u.name AS created_by_name
           FROM custom_emoji e JOIN users u ON u.id = e.created_by
           ORDER BY e.name"""
    )
    return {"items": [_out(r) for r in rows]}


class CreateCustomEmojiRequest(BaseModel):
    name: str = Field(min_length=2, max_length=24)
    image_url: str = Field(min_length=1, max_length=2000)


@router.post("", status_code=201)
async def create_custom_emoji(body: CreateCustomEmojiRequest, user: CurrentUser = Depends(require_auth)):
    """新規カスタム絵文字の登録。画像自体は事前にA-61（POST /api/icons）でアップロード済みで、
    ここではその公開URLをnameに紐づけるだけ（アップロードと登録を分離することで、A-61の既存の
    バリデーション・ストレージ経路をそのまま再利用できる）。認証済みであれば誰でも作成できる
    （ユーザーが選択した方針）。name（大小文字を区別しない）の重複はDBのUNIQUE制約に任せ、
    違反時は409で案内する。"""
    name = body.name.strip()
    if not _NAME_RE.match(name):
        raise HTTPException(422, detail="絵文字名は英数字・アンダースコア・ハイフンのみ、2〜24文字で入力してください")

    pool = get_pool()
    exists = await pool.fetchval(
        "SELECT EXISTS(SELECT 1 FROM custom_emoji WHERE LOWER(name) = LOWER($1))", name,
    )
    if exists:
        raise HTTPException(409, detail=f"「{name}」という名前の絵文字は既に登録されています")

    new_id = await pool.fetchval(
        "INSERT INTO custom_emoji (name, image_url, created_by) VALUES ($1, $2, $3) RETURNING id",
        name, body.image_url, user.id,
    )
    row = await pool.fetchrow(
        """SELECT e.id, e.name, e.image_url, e.created_at, u.name AS created_by_name
           FROM custom_emoji e JOIN users u ON u.id = e.created_by WHERE e.id = $1""",
        new_id,
    )
    return _out(row)


@router.delete("/{emoji_id}", status_code=204)
async def delete_custom_emoji(emoji_id: int, user: CurrentUser = Depends(require_auth)):
    """作成者本人、またはシステム管理者のみ削除できる（他の利用者が既にリアクション・本文で
    使用している場合でも削除自体は妨げない——message_reactions.emoji・messages.bodyは
    自由文字列でこのテーブルへの外部キーを持たないため、削除後は単に画像が表示されず
    `:name:`という文字列がそのまま見える状態になる。Slack等でも絵文字削除後の既存投稿は
    同様に元のテキスト表記に戻る挙動のため、この程度の割り切りは妥当と判断した）。
    実ファイル（Supabase Storage ICON_BUCKET）は削除しない（モジュール冒頭コメント参照）。"""
    pool = get_pool()
    row = await pool.fetchrow("SELECT created_by FROM custom_emoji WHERE id = $1", emoji_id)
    if row is None:
        raise HTTPException(404, detail="見つかりません")
    if row["created_by"] != user.id and user.role != "admin":
        raise HTTPException(403, detail="削除する権限がありません")
    await pool.execute("DELETE FROM custom_emoji WHERE id = $1", emoji_id)
