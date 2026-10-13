import { ApiError, errorMessage } from './api.js';
import type { Operation } from './api.js';
export type PrintState = {
  busy: boolean;
  operation: Operation | null;
  message: string;
  key: string | null;
};
function createUuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export class PrintController {
  private state: PrintState = { busy: false, operation: null, message: '', key: null };
  private fingerprint = '';
  constructor(
    private send: (fileId: string, key: string) => Promise<Operation>,
    private update: (state: PrintState) => void,
    private confirm: () => boolean,
  ) {}
  async start(fileId: string) {
    if (this.state.busy || this.state.operation?.state === 'accepted') return;
    if (!this.confirm()) return;
    const fingerprint = fileId;
    const key = this.fingerprint === fingerprint && this.state.key ? this.state.key : createUuid();
    this.fingerprint = fingerprint;
    this.state = { ...this.state, busy: true, message: '印刷要求を送信中…', key };
    this.update({ ...this.state });
    try {
      const operation = await this.send(fileId, key);
      this.state.operation = operation;
      this.state.message =
        operation.state === 'accepted'
          ? '印刷開始の要求を受け付けました。'
          : operation.state === 'pending'
            ? '印刷要求を処理中です。'
            : operation.state === 'unknown'
              ? '結果が不明です。プリンターの画面を確認してください。'
              : operation.error
                ? errorMessage(new ApiError(502, operation.error.code, operation.error.message))
                : '印刷できませんでした。';
    } catch (error) {
      this.state.message =
        error instanceof ApiError
          ? errorMessage(error)
          : '通信に失敗しました。プリンターを確認し、「結果を確認」を押してください。';
    } finally {
      this.state.busy = false;
      this.update({ ...this.state });
    }
  }
}
