import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
const Viewer = lazy(() => import('./Viewer.js').then((module) => ({ default: module.Viewer })));
import { ApiError, fetchApi, readLimitedText, errorMessage } from './api.js';
import type { Metadata, Operation } from './api.js';
import { PrintController } from './print-controller.js';
import type { PrintState } from './print-controller.js';
const INITIAL: PrintState = { busy: false, operation: null, message: '', key: null };
function duration(seconds: number | null) {
  if (seconds === null) return '未取得';
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}時間 ${minutes % 60}分` : `${minutes}分`;
}
export function App() {
  const uuid = window.location.pathname.split('/').filter(Boolean).at(-1) ?? '';
  const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
  const [input, setInput] = useState(''),
    [token, setToken] = useState(''),
    [file, setFile] = useState<Metadata | null>(null),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [ready, setReady] = useState(false),
    [printerEnabled, setPrinterEnabled] = useState(false),
    [printState, setPrintState] = useState<PrintState>(INITIAL);
  const onViewerReady = useCallback((value: boolean) => setReady(value), []);
  const controller = useMemo(
    () =>
      new PrintController(
        async (fileId, key) => {
          const response = await fetch('/api/printer/print', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Idempotency-Key': key,
            },
            body: JSON.stringify({ fileId }),
          });
          const body = await response.json();
          if (body.state) return body as Operation;
          throw new ApiError(
            response.status,
            body.error?.code ?? 'request_failed',
            body.error?.message ?? '印刷要求に失敗しました。',
          );
        },
        setPrintState,
        () =>
          window.confirm(
            '表示中のファイルをA1 miniで印刷します。ベッドが空で、材料とプレートが適切であることを確認してください。プリンターの加熱・動作を開始します。続行しますか？',
          ),
      ),
    [token],
  );
  useEffect(() => {
    if (!token || !validUuid) return;
    const abort = new AbortController();
    setLoading(true);
    setError('');
    setText('');
    setFile(null);
    setReady(false);
    setPrintState(INITIAL);
    void (async () => {
      try {
        const metadata = (await (
          await fetchApi(`/api/files/${uuid}`, token, { signal: abort.signal })
        ).json()) as Metadata;
        setFile(metadata);
        if (metadata.state !== 'ready' || !['gcode', 'gcode.3mf'].includes(metadata.format))
          throw new Error('保存済みのスライス結果UUIDを指定してください。');
        const state = await (await fetchApi('/api/ready', token, { signal: abort.signal })).json();
        setPrinterEnabled(state.printerEnabled === true);
        const response = await fetchApi(`/api/files/${uuid}/gcode`, token, {
          signal: abort.signal,
        });
        const gcode = await readLimitedText(response, abort.signal);
        abort.signal.throwIfAborted();
        setText(gcode);
      } catch (e) {
        if (!abort.signal.aborted) setError(errorMessage(e));
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    })();
    return () => abort.abort();
  }, [token, uuid, validUuid]);
  async function download() {
    try {
      const response = await fetchApi(`/api/files/${uuid}/download`, token);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = file?.name ?? `${uuid}.gcode.3mf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/docs">
          <span className="brand-symbol">◈</span> pi_wedge
        </a>
        <span className="header-tag">SLICE PREVIEW</span>
        <div className="connection">
          <span className={printerEnabled ? 'dot active' : 'dot'} />
          {printerEnabled ? 'LANプリンター設定済み' : 'プリンター無効'}
        </div>
        <a className="api-link" href="/docs">
          API ↗
        </a>
      </header>
      <main className="workspace">
        <div className="model-area">
          {text ? (
            <Suspense
              fallback={
                <div className="empty-view" role="status">
                  3Dビューアーを読み込み中…
                </div>
              }
            >
              <Viewer text={text} onReady={onViewerReady} />
            </Suspense>
          ) : (
            <div className="empty-view">
              <span className="empty-icon">◈</span>
              <h1>印刷前に、ツールパスを確認。</h1>
              <p>A1 miniのスライス結果を3Dで表示します。</p>
              {!validUuid ? (
                <p className="error" role="alert">
                  /preview/ファイルUUID のURLで開いてください。
                </p>
              ) : !token ? (
                <form
                  className="auth-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setToken(input.trim());
                    setInput('');
                  }}
                >
                  <label htmlFor="token">APIトークン</label>
                  <input
                    id="token"
                    type="password"
                    autoComplete="off"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    required
                    minLength={32}
                    placeholder="管理者が設定したAPI_TOKEN"
                  />
                  <button className="primary" type="submit">
                    プレビューを開く
                  </button>
                  <small>トークンはこの画面のメモリにだけ保持します。</small>
                </form>
              ) : loading ? (
                <p role="status">スライス結果を取得しています…</p>
              ) : (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}
          {text && error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <aside className="sidebar">
          <div className="eyebrow">PRINT FILE</div>
          <h2>{file?.name ?? 'スライス結果'}</h2>
          <span className="format-tag">{file?.format.toUpperCase() ?? 'GCODE / 3MF'}</span>
          <div className="uuid-block">
            <span>ファイル UUID</span>
            <code>{uuid || '未指定'}</code>
          </div>
          <div className="stats">
            <div>
              <span>推定造形時間</span>
              <strong>{duration(file?.estimatedSeconds ?? null)}</strong>
            </div>
            <div>
              <span>フィラメント使用量</span>
              <strong>
                {file?.filamentGrams != null ? `${file.filamentGrams.toFixed(1)} g` : '未取得'}
              </strong>
              <small>
                {file?.filamentMillimeters != null
                  ? `${(file.filamentMillimeters / 1000).toFixed(2)} m`
                  : ''}
              </small>
            </div>
          </div>
          <div className="machine-card">
            <span>出力先</span>
            <strong>Bambu Lab A1 mini</strong>
            <small>0.4 mm ノズル · 180 mm プレート</small>
          </div>
          <div className="print-panel">
            <p>印刷開始時にファイルを転送します。材料とベッドを確認してください。</p>
            <button
              className="print-button"
              disabled={
                !ready ||
                !printerEnabled ||
                printState.busy ||
                printState.operation?.state === 'accepted' ||
                printState.operation?.state === 'unknown'
              }
              onClick={() => void controller.start(uuid)}
            >
              {printState.busy
                ? '転送・要求中…'
                : printState.operation?.state === 'accepted'
                  ? '開始要求を受付済み'
                  : printState.key
                    ? '同じ操作の結果を再確認'
                    : '印刷を開始'}
            </button>
            {!printerEnabled && <small>APIサーバーのプリンター設定が必要です。</small>}
            {printState.message && (
              <p
                className={`print-message ${printState.operation?.state === 'accepted' ? 'success' : ''}`}
                role="status"
              >
                {printState.message}
              </p>
            )}
            {printState.key && <small className="operation-id">操作ID: {printState.key}</small>}
          </div>
          {file && (
            <button className="secondary" onClick={() => void download()}>
              元ファイルをダウンロード ↓
            </button>
          )}
          {token && (
            <button
              className="text-button"
              disabled={printState.busy}
              onClick={() => {
                setToken('');
                setText('');
                setFile(null);
                setReady(false);
              }}
            >
              トークンを再入力
            </button>
          )}
        </aside>
      </main>
      <footer>
        LAN内で処理・保存 <span>プレビュー操作ではプリンターは動きません</span>
      </footer>
    </div>
  );
}
