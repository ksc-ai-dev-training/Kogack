# Kogack の本番イメージ（Fly.io 向け）。
# frontend（React/Vite）を静的ファイルにビルドし、backend（FastAPI）が
# そのビルド成果物を配信しつつ API も提供する「1プロセスだけ」の構成にする
# （backend/main.py の SPA 配信フォールバックが元からこの前提で書かれている）。

# ============================================================
# ステージ1: frontend をビルドする（このステージの中身は最終イメージに残らない）
# ============================================================
FROM node:24-slim AS frontend-build
WORKDIR /app/frontend

# package.json と package-lock.json だけを先にコピーして npm ci を実行する。
# ソースコードより先に依存関係だけをインストールしておくと、ソースコードだけを
# 変更した次回以降のビルドでは「npm ci」の結果がキャッシュから再利用され、
# 依存パッケージの再ダウンロードが走らずビルドが速くなる。
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# 残りのソースコードをコピーしてビルドする（tsc -b && vite build）。
# 出力は frontend/dist に生成される。
COPY frontend/ ./
RUN npm run build


# ============================================================
# ステージ2: backend（本番で実際に動くのはこちらだけ）
# ============================================================
FROM python:3.14-slim AS backend
WORKDIR /app

# ステージ1で作った frontend/dist だけをコピーする（Node.js 本体や
# node_modules は最終イメージに一切含まれない）。backend/main.py は
# 「backend の1つ上の階層にある frontend/dist」を静的配信する前提で
# 書かれているため、コンテナの中でも同じ位置関係を再現する。
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

WORKDIR /app/backend

# requirements.txt だけ先にコピーして pip install する（frontend と同じ理由でキャッシュを効かせる）
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 残りの backend のソースコードをコピーする
COPY backend/ ./

# コンテナの中を root ユーザーのままにしない（最小権限。もしアプリに
# 脆弱性があっても、コンテナ内で管理者権限を奪われる被害を抑える）
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

# Fly.io のようなPaaSは「このコンテナは何番ポートで待ち受けているか」を
# 起動時に環境変数 PORT で渡してくる（値は環境によって変わりうる）。
# イメージの中に決め打ちのポート番号を書かず、起動コマンドの中で
# その都度 ${PORT} を読む。ここでの ENV は「PORT が渡されなかったときの既定値」。
ENV PORT=8000
# EXPOSE はポートを実際に開放するものではなく「このイメージは
# このポートで待ち受ける想定です」という説明（メタデータ）。Fly.io は
# 実際にはこの値ではなく fly.toml の internal_port を見るが、
# 一般的な作法として残してある。
EXPOSE 8000

# コンテナ起動時に実行されるコマンド。${PORT:-8000} は「環境変数 PORT が
# 設定されていればその値、無ければ 8000」という意味（シェルの変数展開機能）。
# シェル変数展開を使うため、あえて "sh -c" 経由で実行している。
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
