import { ApiError, errorMessage } from './api.js';
import type { Operation, BrowserPrintSettings } from './api.js';
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
  private settings: BrowserPrintSettings = { useAms: false };
  constructor(
    private send: (
      fileId: string,
      key: string,
      settings: BrowserPrintSettings,
    ) => Promise<Operation>,
    private update: (state: PrintState) => void,
    private confirm: (settings: BrowserPrintSettings, message?: string) => boolean,
  ) {}
  restore(fileId: string) {
    this.state = { busy: false, operation: null, message: '', key: null };
    this.settings = { useAms: false };
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(`pi_wedge:print:${fileId}`);
        if (raw) {
          const saved = JSON.parse(raw);
          if (
            !/^[0-9a-f-]{36}$/i.test(saved.key) ||
            typeof saved.settings?.useAms !== 'boolean' ||
            (saved.settings.useAms &&
              (!Array.isArray(saved.settings.amsMapping) ||
                saved.settings.amsMapping.length !== 1 ||
                !Number.isInteger(saved.settings.amsMapping[0]) ||
                saved.settings.amsMapping[0] < 0 ||
                saved.settings.amsMapping[0] > 3))
          )
            throw new Error('Invalid saved request');
          this.settings = saved.settings;
          this.state.key = saved.key;
          this.state.operation = saved.operation ?? null;
          this.state.message =
            this.state.operation?.state === 'accepted'
              ? '印刷開始の要求を受け付けました。'
              : this.state.operation?.state === 'unknown'
                ? '結果が不明です。プリンターの画面を確認してください。'
                : this.state.operation?.state === 'failed'
                  ? '前回の印刷要求は失敗しました。'
                  : '前回の印刷要求の結果を確認してください。';
        }
      } catch {
        this.state.message =
          '保存した印刷要求を読み込めません。プリンターの画面を確認してください。';
        this.state.operation = { id: '', state: 'unknown', error: null };
      }
    }
    this.update({ ...this.state });
    return this.settings;
  }
  private persist(fileId: string) {
    if (typeof window !== 'undefined')
      window.localStorage.setItem(
        `pi_wedge:print:${fileId}`,
        JSON.stringify({
          key: this.state.key,
          settings: this.settings,
          operation: this.state.operation,
        }),
      );
  }
  async start(
    fileId: string,
    settings: BrowserPrintSettings = { useAms: false },
    message?: string,
  ) {
    if (this.state.busy || ['accepted', 'unknown'].includes(this.state.operation?.state ?? ''))
      return;
    const unresolved =
      this.state.key && (!this.state.operation || this.state.operation.state === 'pending');
    const request = unresolved
      ? this.settings
      : {
          useAms: settings.useAms,
          ...(settings.useAms ? { amsMapping: [...(settings.amsMapping ?? [])] } : {}),
        };
    if (!this.confirm(request, message)) return;
    if (!unresolved) {
      this.settings = request;
      this.state.key = createUuid();
      this.state.operation = null;
    }
    try {
      // Save the exact request before dispatch; lost responses and page reloads reuse it.
      this.persist(fileId);
    } catch {
      this.state.message =
        '印刷要求をブラウザーに保存できません。保存を許可して開き直してください。';
      this.update({ ...this.state });
      return;
    }
    this.state = { ...this.state, busy: true, message: '印刷要求を送信中…' };
    this.update({ ...this.state });
    try {
      const operation = await this.send(fileId, this.state.key!, this.settings);
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
      try {
        this.persist(fileId);
      } catch {
        /* The pre-dispatch key is already stored. */
      }
      this.update({ ...this.state });
    }
  }
}
