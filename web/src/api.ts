export type Metadata = {
  id: string;
  name: string;
  format: string;
  state: string;
  estimatedSeconds: number | null;
  filamentGrams: number | null;
  filamentMillimeters: number | null;
};
export type Operation = {
  id: string;
  state: 'pending' | 'accepted' | 'failed' | 'unknown';
  error: { code: string; message: string } | null;
};
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function fetchApi(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'request_failed',
      body?.error?.message ?? `HTTP ${response.status}`,
    );
  }
  return response;
}
export function errorMessage(error: unknown) {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 401:
        return 'APIトークンを確認してください。';
      case 404:
        return '指定されたファイルが見つかりません。';
      case 413:
        return 'このG-codeはプレビューの上限を超えています。ファイルをダウンロードして確認できます。';
      case 422:
        return 'G-codeまたは印刷コンテナが不正です。';
      case 409:
        return '現在のファイルやプリンターの状態では操作できません。';
      case 503:
        return 'ストレージまたはプリンターが利用できません。';
    }
    return error.message;
  }
  return error instanceof Error ? error.message : '処理に失敗しました。';
}
export async function readLimitedText(
  response: Response,
  signal: AbortSignal,
  maxBytes = 32 * 1048576,
) {
  if (Number(response.headers.get('Content-Length') ?? 0) > maxBytes)
    throw new ApiError(413, 'too_large', 'Preview size exceeded');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('G-codeを取得できません。');
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new ApiError(413, 'too_large', 'Preview size exceeded');
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
