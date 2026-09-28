# 操作マニュアル（docs/06_操作マニュアル.html）のアプリ内配信（ユーザーからの明示的な要望
# 「アプリ上で操作マニュアルを確認できるようにしてほしい」、2026-09-28）。設計書一式（docs/）の
# うちマニュアル本体・共通スタイル・画面キャプチャだけを /manual/ 配下で返す。画面側は
# S-xx相当の独立画面を作らず、フロントの /help（HelpView.tsx）がこれをiframeで表示する。
# マニュアルはファイルを二重管理しないよう docs/ の原本をそのまま読み、設計書用のサイドナビ
# （_sidenav.js、他の設計書へのリンク集）は読み込ませず、開発者向けの改訂履歴も省く。
# 閲覧はログイン済みの利用者に限る（未ログインはログイン画面へ戻す。APIと違いブラウザが
# 直接開くページのため401のJSONではなくリダイレクトにする）。
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse

from auth_helpers import require_auth
from database import ROOT_ENV

router = APIRouter(tags=["manual"])

DOCS_DIR = Path(ROOT_ENV.get("MANUAL_DOCS_DIR", "") or Path(__file__).resolve().parent.parent.parent / "docs")
MANUAL_HTML = DOCS_DIR / "06_操作マニュアル.html"
# 直接返してよいファイルの置き場所（ディレクトリトラバーサル対策の許可リスト）
_ALLOWED_DIRS = [(DOCS_DIR / "assets").resolve(), (DOCS_DIR / "操作マニュアル画像").resolve()]
_NO_CACHE_HEADERS = {"Cache-Control": "no-cache"}
_REVISION_HISTORY_START = "<!-- ============ 改訂履歴 ============ -->"
_TOC_START = '<div class="toc">'


@router.get("/manual", include_in_schema=False)
async def manual_root():
    # 相対パスの画像・CSS（assets/style.css等）を /manual/ 基準で解決させるため末尾スラッシュへ寄せる
    return RedirectResponse("/manual/")


@router.get("/manual/{path:path}", include_in_schema=False)
async def manual_file(path: str, request: Request):
    try:
        await require_auth(request)
    except HTTPException:
        return RedirectResponse("/login")
    if path in ("", "index.html"):
        html = MANUAL_HTML.read_text(encoding="utf-8")
        html = html.replace('<script src="_sidenav.js"></script>', "")
        # 改訂履歴（開発者向けの長い表）は利用者には不要なため省き、目次から始める
        start = html.find(_REVISION_HISTORY_START)
        end = html.find(_TOC_START)
        if 0 <= start < end:
            html = html[:start] + html[end:]
        return HTMLResponse(html, headers=_NO_CACHE_HEADERS)
    candidate = (DOCS_DIR / path).resolve()
    if candidate.is_file() and any(candidate.is_relative_to(d) for d in _ALLOWED_DIRS):
        return FileResponse(candidate, headers=_NO_CACHE_HEADERS)
    raise HTTPException(404, detail="Not Found")
