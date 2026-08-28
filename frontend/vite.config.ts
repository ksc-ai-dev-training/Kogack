import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// リポジトリルートの .env（DB_PORT / BACKEND_PORT / FRONTEND_PORT）を直接読む。
// 環境変数が設定されている場合はそちらを優先する（start.bat 経由の起動など）。
function loadRootEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const text = readFileSync(resolve(root, '.env'), 'utf-8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
  } catch {
    // .env が無ければ既定値を使う
  }
  return env
}

// .env を常に正とする（プロセス起動時の古い環境変数に引きずられないように）
const rootEnv = loadRootEnv()
const backendPort = rootEnv.BACKEND_PORT ?? process.env.BACKEND_PORT ?? '8011'
const frontendPort = Number(rootEnv.FRONTEND_PORT ?? process.env.FRONTEND_PORT ?? '5174')

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: frontendPort,
    proxy: {
      // changeOrigin: falseで、バックエンドへ転送するリクエストのHostヘッダーを
      // ブラウザが実際にアクセスしているlocalhost:{frontendPort}のまま維持する
      // （既定のchangeOrigin:trueだと転送先のlocalhost:{backendPort}に書き換わってしまい、
      // google_auth.pyのredirect_uri_for()がHostヘッダーから組み立てるコールバックURLの
      // ポート番号がバックエンド側になってしまう。Google Cloud Consoleにはフロントエンドの
      // ポート（ブラウザが実際に見ているアドレス）で登録されているため、これが一致しないと
      // ローカルでのGoogle認証がredirect_uri_mismatchで失敗する）。
      '/api': { target: `http://localhost:${backendPort}`, changeOrigin: false },
    },
  },
})
