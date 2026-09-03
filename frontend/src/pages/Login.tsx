import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import useSWR from 'swr'
import { apiFetch } from '../lib/api'
import { useMe } from '../hooks/useMe'
import type { DevUser } from '../types'

const ROLE_LABELS: Record<string, string> = {
  admin: 'システム管理者',
  member: '一般',
}

// A-02 が認証を拒否したときに ?error= で渡してくる種別（詳細設計書 総論7.2節の4種類）
const LOGIN_ERRORS: Record<string, string> = {
  domain_not_allowed:
    'このアカウントではログインできません。@kogasoftware.com のアカウントでログインし直してください。',
  account_disabled: 'アカウントが無効化されています。管理者にお問い合わせください。',
  oauth_failed: 'ログインに失敗しました。もう一度お試しください。',
  // Googleの同意画面で「キャンセル」を押した場合等。理由を明示し、次に何をすればよいか案内する
  // （ユーザーからの報告を受けて追加。従来はoauth_failedと同じ理由不明のメッセージだった）
  consent_denied:
    'Googleへのアクセス許可が完了しなかったため、ログインできませんでした。もう一度「Googleでログイン」を押し、表示された内容を「許可」してください。',
}

// S-01 ログイン画面（画面モックアップ S-01_ログイン.html）。
// ローカル開発では Google 認証の代わりに開発用ログインを表示する
export default function Login() {
  const navigate = useNavigate()
  const { mutate } = useMe()
  const [error, setError] = useState<string | null>(null)
  const [searchParams] = useSearchParams()
  const { data } = useSWR<{ items: DevUser[] }>('/api/auth/dev-users', apiFetch)

  const authError = searchParams.get('error')
  const authErrorMessage = authError
    ? (LOGIN_ERRORS[authError] ?? LOGIN_ERRORS.oauth_failed)
    : null

  const devLogin = async (email: string) => {
    setError(null)
    try {
      await apiFetch('/api/auth/dev-login', {
        method: 'POST',
        body: JSON.stringify({ email }),
      })
      await mutate()
      navigate('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ログインに失敗しました')
    }
  }

  return (
    <div
      className="flex min-h-screen items-center justify-center p-6"
      style={{
        background:
          'radial-gradient(circle at 20% 15%, #eef4ff 0%, var(--color-surface-muted) 45%, #eef2f7 100%)',
      }}
    >
      <div className="w-full max-w-[380px] rounded-2xl border border-line bg-surface px-9 pb-8 pt-11 shadow-[0_12px_32px_rgba(16,24,40,0.10),0_2px_6px_rgba(16,24,40,0.06)]">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-3.5 flex h-13 w-13 items-center justify-center rounded-[14px] bg-gradient-to-br from-accent-600 to-accent-700 text-[22px] font-bold text-white shadow-[0_4px_10px_rgba(30,64,175,0.28)]">
            K
          </div>
          <div className="text-xl font-bold tracking-tight text-accent-700">Kogack</div>
          <div className="mt-1 text-[12.5px] text-ink-muted">AIネイティブチャットシステム</div>
        </div>

        <p className="mb-6 text-center text-[13px] leading-relaxed text-ink-muted">
          社内の会話とAIエージェントがひとつになった
          <br />
          チームチャットです。
        </p>

        {authErrorMessage && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-danger-border bg-danger-bg px-3 py-2.5 text-[12px] leading-relaxed text-danger-text">
            <span>⚠</span>
            <span>{authErrorMessage}</span>
          </div>
        )}

        <a
          href="/api/auth/login"
          className="flex w-full items-center justify-center gap-2.5 rounded-[10px] border border-line-strong bg-white px-4 py-2.5 text-sm font-semibold text-[#3c4043] transition hover:border-[#c7cdd6] hover:bg-surface-subtle hover:shadow-sm"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="flex-none">
            <path
              fill="#4285F4"
              d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.87 2.7-6.62z"
            />
            <path
              fill="#34A853"
              d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.98v2.33A9 9 0 0 0 9 18z"
            />
            <path
              fill="#FBBC05"
              d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.16.28-1.7V4.97H.98A9 9 0 0 0 0 9c0 1.45.35 2.83.98 4.03l2.97-2.33z"
            />
            <path
              fill="#EA4335"
              d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .98 4.97l2.97 2.33C4.66 5.17 6.65 3.58 9 3.58z"
            />
          </svg>
          Googleでログイン
        </a>
        <p className="mt-3.5 text-center text-[11.5px] leading-relaxed text-ink-subtle">
          社用Googleアカウント（
          <code className="rounded border border-line bg-surface-muted px-1 font-mono">
            @kogasoftware.com
          </code>
          ）でログインできます。
        </p>

        {data && data.items.length > 0 && (
          <>
            <hr className="my-6 border-line" />
            <p className="mb-2 text-center text-[11px] font-bold text-amber-600">
              開発用ログイン（Google認証の代替）
            </p>
            <ul className="space-y-1.5">
              {data.items.map((u) => (
                <li key={u.email}>
                  <button
                    onClick={() => devLogin(u.email)}
                    className="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-line-strong hover:bg-surface-subtle"
                  >
                    <span>
                      <span className="font-medium text-ink">{u.name}</span>
                      <span className="ml-2 text-xs text-ink-subtle">{u.email}</span>
                    </span>
                    <span className="rounded bg-surface-muted px-2 py-0.5 text-[10px] font-semibold text-ink-muted">
                      {ROLE_LABELS[u.role]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {error && <p className="mt-4 text-center text-sm text-danger-text">{error}</p>}

        <footer className="mt-7 text-center text-[11px] text-ink-subtle">Kogack v1.0</footer>
      </div>
    </div>
  )
}
