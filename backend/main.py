# FastAPIアプリ生成、ルーター登録、静的配信フォールバック（詳細設計書 総論2章）
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

import database
from routers import admin, auth, channels, dms, icons, messages, search, users


@asynccontextmanager
async def lifespan(app: FastAPI):
    await database.init_pool()
    yield
    await database.close_pool()


app = FastAPI(title="Kogack API", lifespan=lifespan)

app.include_router(admin.router)
app.include_router(auth.router)
app.include_router(channels.router)
app.include_router(dms.router)
app.include_router(icons.router)
app.include_router(messages.router)
app.include_router(search.router)
app.include_router(users.router)


@app.get("/healthz", include_in_schema=False)
async def healthz():
    """Koyeb のヘルスチェック用。DBまで疎通しているかを確認する"""
    try:
        await database.get_pool().fetchval("SELECT 1")
    except Exception:
        return JSONResponse(status_code=503, content={"status": "unhealthy"})
    return {"status": "ok", "env": database.APP_ENV}


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    import traceback
    traceback.print_exc()
    return JSONResponse(status_code=500, content={"detail": "サーバーエラーが発生しました"})


# --- フロントエンドの静的配信（本番はSPAをFastAPIが配信する。詳細設計書 総論2.1節） ---
# frontend/dist があるときだけ有効。ローカル開発では Vite が配信するため通常は存在しない。
BACKEND_DIR = Path(__file__).resolve().parent
FRONTEND_DIST = Path(
    database.ROOT_ENV.get("FRONTEND_DIST", "")
    or BACKEND_DIR.parent / "frontend" / "dist"
)

if FRONTEND_DIST.is_dir():
    _INDEX_HTML = FRONTEND_DIST / "index.html"
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        """SPAフォールバック。/api 配下以外はビルド済みの index.html を返し、
        クライアントサイドルーティング（react-router）に委ねる。"""
        if full_path.startswith("api/"):
            raise HTTPException(404, detail="Not Found")
        candidate = (FRONTEND_DIST / full_path).resolve()
        # ディレクトリトラバーサル対策: dist配下に収まる実在ファイルのみ直接返す
        if full_path and candidate.is_file() and candidate.is_relative_to(FRONTEND_DIST.resolve()):
            return FileResponse(candidate)
        return FileResponse(_INDEX_HTML)


if __name__ == "__main__":
    # `python main.py` で起動する場合もルートの .env の BACKEND_PORT を反映する
    import os

    import uvicorn

    port = int(database.ROOT_ENV.get("BACKEND_PORT") or os.environ.get("BACKEND_PORT", "8011"))
    uvicorn.run("main:app", port=port, reload=True)
