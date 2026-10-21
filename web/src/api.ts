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
export type PreviewData = {
  file: Metadata;
  displayName: string;
  printerEnabled: boolean;
  plate: number;
  plateId: string;
  previewId: string;
  plates: { id: string; plate: number }[];
};
export type HistoryItem = {
  id: string;
  plateId?: string;
  previewId?: string;
  plateCount?: number;
  name: string;
  createdAt: string;
  format: 'gcode' | 'gcode.3mf';
  estimatedSeconds: number | null;
  filamentGrams: number | null;
};
export type HistoryPage = { items: HistoryItem[]; nextCursor: string | null };
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function fetchPreview(path: string, init: RequestInit = {}) {
  const response = await fetch(path, init);
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
    switch (error.code) {
      case 'plate_not_found':
        return 'プレートが見つかりません。URLを確認してください。';
      case 'printer_status_unavailable':
        return 'AMSの状態を取得できません。接続を確認して更新してください。';
      case 'ams_slot_unavailable':
        return '選択したAMSスロットが空か、状態を確認できません。';
      case 'ams_material_mismatch':
        return 'AMSの材料がスライスのPLA設定と一致しません。';
      case 'printer_disabled':
        return 'プリンターが未設定です。';
      case 'printer_busy':
        return 'プリンターは使用中です。';
      case 'printer_rejected':
        return 'プリンターが印刷要求を拒否しました。プリンターの画面を確認してください。';
      case 'printer_outcome_unknown':
        return '結果が不明です。プリンターの画面を確認してください。';
      case 'printer_upload_failed':
        return 'ファイルを転送できませんでした。プリンターの接続を確認してください。';
      case 'file_not_ready':
        return 'ファイルの準備ができていません。';
      case 'wrong_kind':
        return 'このファイルはプレビューできません。';
      case 'preview_busy':
        return 'プレビューが混み合っています。しばらくしてから開き直してください。';
      case 'storage_unavailable':
      case 'storage_size_mismatch':
      case 'object_missing':
        return '保存済みファイルを読み込めません。';
      case 'dependency_unavailable':
        return 'サーバーが利用できません。しばらくしてから開き直してください。';
      case 'idempotency_conflict':
        return '印刷要求が一致しません。プリンターの画面を確認してください。';
    }
    switch (error.status) {
      case 400:
        return '操作を受け付けられませんでした。ページを開き直してください。';
      case 403:
        return 'プレビューページを開き直してください。';
      case 404:
        return 'ファイルが見つかりません。';
      case 413:
        return 'G-codeがプレビューの容量上限を超えています。ダウンロードして確認してください。';
      case 422:
        return '印刷ファイルが不正です。';
      case 409:
        return '現在の状態では操作できません。';
      case 503:
        return 'サーバーまたはプリンターが利用できません。';
      case 502:
        return '印刷できませんでした。プリンターの接続を確認してください。';
      case 504:
        return '結果が不明です。プリンターの画面を確認してください。';
    }
    return '処理に失敗しました。';
  }
  if (error instanceof TypeError) return '通信に失敗しました。接続を確認してください。';
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

export type { PrinterStatus } from '../../src/domain/schemas.js';
export type BrowserPrintSettings = { useAms: boolean; amsMapping?: number[] };
