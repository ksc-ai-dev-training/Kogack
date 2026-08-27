// APIクライアント（fetchラッパー）。401は共通処理で /login へリダイレクトする
// （詳細設計書 画面設計11.7節）。403/404はここではグローバル処理しない — 意味が呼び出し元に
// よって異なるため（例: S-06/S-08のガードは呼び出し元が個別に判定する。総論5.9節）。

export class ApiError extends Error {
  status: number
  constructor(status: number, detail: string) {
    super(detail)
    this.status = status
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.location.href = '/login'
  }
  if (!res.ok) {
    let detail = 'エラーが発生しました'
    try {
      const body = await res.json()
      if (body.detail) detail = body.detail
    } catch {
      // JSONでないレスポンスは汎用メッセージのまま
    }
    throw new ApiError(res.status, detail)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}
