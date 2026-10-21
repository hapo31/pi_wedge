import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
const Viewer = lazy(() => import('./Viewer.js').then((module) => ({ default: module.Viewer })));
import { getRouteApi, Link, useParams } from '@tanstack/react-router';
import { ApiError, fetchPreview, errorMessage } from './api.js';
import { getPreviewData, getPreviewText, getPrinterStatus } from './preview-queries.js';
import { usePreviewLayout } from './App.js';
import type { Metadata, Operation } from './api.js';
import { AmsSettings } from './AmsSettings.js';
import type { PrinterStatus, BrowserPrintSettings } from './api.js';
import { PrintController } from './print-controller.js';
import type { PrintState } from './print-controller.js';
const INITIAL: PrintState = { busy: false, operation: null, message: '', key: null };
function duration(seconds: number | null) {
  if (seconds === null) return '未取得';
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}時間 ${minutes % 60}分` : `${minutes}分`;
}
const previewRoute = getRouteApi('/preview/$plateId');
export function PreviewScreen() {
  const { plateId: uuid } = previewRoute.useParams();
  const { previewId = '' } = useParams({ strict: false });
  const { updatePreview, setPrintBusy, sidebarHeight, reserveSidebarHeight } = usePreviewLayout();
  const sidebar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = sidebar.current;
    if (!element) return;
    const measure = () => reserveSidebarHeight(element.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [reserveSidebarHeight]);
  const plateQuery = previewId ? `?previewId=${previewId}` : '';
  const [plates, setPlates] = useState<{ id: string; plate: number }[]>([]);
  const [selectedPlate, setSelectedPlate] = useState(1);
  const [plateId, setPlateId] = useState(uuid);
  const validUuid = [uuid, ...(previewId ? [previewId] : [])].every((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
  );
  const [file, setFile] = useState<Metadata | null>(null),
    [displayName, setDisplayName] = useState(''),
    [text, setText] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(validUuid),
    [ready, setReady] = useState(false),
    [printerEnabled, setPrinterEnabled] = useState(false),
    [printState, setPrintState] = useState<PrintState>(INITIAL),
    [printerStatus, setPrinterStatus] = useState<PrinterStatus | null>(null),
    [statusLoading, setStatusLoading] = useState(false),
    [statusError, setStatusError] = useState(''),
    [refresh, setRefresh] = useState(0),
    [selectedSlot, setSelectedSlot] = useState<number | null>(null);
  const onViewerReady = useCallback((value: boolean) => setReady(value), []);
  const controller = useMemo(
    () =>
      new PrintController(
        async (_fileId, key, settings) => {
          const response = await fetch(`/preview/${uuid}/print${plateQuery}`, {
            method: 'POST',
            headers: {
              'Idempotency-Key': key,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(settings),
          });
          const body = await response.json();
          if (body.state) return body as Operation;
          throw new ApiError(
            response.status,
            body.error?.code ?? 'request_failed',
            body.error?.message ?? '印刷できませんでした。',
          );
        },
        setPrintState,
        (_settings, message) => window.confirm(message ?? '印刷しますか？'),
      ),
    [uuid, plateQuery],
  );
  useEffect(() => {
    if (!validUuid) return;
    const abort = new AbortController();
    setLoading(true);
    setError('');
    setText('');
    setFile(null);
    setReady(false);
    setPrinterEnabled(false);

    void (async () => {
      try {
        const data = await getPreviewData(uuid, previewId, abort.signal);
        abort.signal.throwIfAborted();
        // Commit only active results. The parent keeps the previous list while
        // this child loads and when a selected plate cannot be fetched.
        updatePreview(data);
        setPlates(data.plates ?? [{ id: previewId, plate: 1 }]);
        setSelectedPlate(data.plate ?? 1);
        setPlateId(data.plateId ?? uuid);
        const saved = controller.restore(previewId || uuid);
        setSelectedSlot(saved.useAms ? (saved.amsMapping?.[0] ?? null) : null);
        const metadata = data.file;
        setFile(metadata);
        setDisplayName(data.displayName);
        if (metadata.state !== 'ready' || !['gcode', 'gcode.3mf'].includes(metadata.format))
          throw new Error('このファイルはプレビューできません。');
        setPrinterEnabled(data.printerEnabled === true);
        const gcode = await getPreviewText(uuid, previewId, abort.signal);
        abort.signal.throwIfAborted();
        setText(gcode);
      } catch (e) {
        if (!abort.signal.aborted) setError(errorMessage(e));
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    })();
    return () => abort.abort();
  }, [uuid, validUuid, controller, previewId, updatePreview]);
  useEffect(() => {
    setPrintBusy(printState.busy);
    return () => setPrintBusy(false);
  }, [printState.busy, setPrintBusy]);
  useEffect(() => {
    if (!file || !printerEnabled) return;
    const abort = new AbortController();
    setStatusLoading(true);
    setStatusError('');
    void (async () => {
      try {
        const snapshot = await getPrinterStatus(uuid, abort.signal);
        abort.signal.throwIfAborted();
        setPrinterStatus(snapshot);
      } catch (e) {
        if (!abort.signal.aborted) {
          setPrinterStatus(null);
          setStatusError(errorMessage(e));
        }
      } finally {
        if (!abort.signal.aborted) setStatusLoading(false);
      }
    })();
    return () => abort.abort();
  }, [file, printerEnabled, uuid, refresh]);
  const settingsLocked =
    printState.busy ||
    ['accepted', 'pending', 'unknown'].includes(printState.operation?.state ?? '') ||
    Boolean(printState.key && !printState.operation);
  const selected = printerStatus?.slots.find((s) => s.slot === selectedSlot);
  const validSupply =
    selectedSlot === null ||
    (printerStatus?.amsConnected === true &&
      selected?.present === true &&
      (!selected.material || selected.material.toUpperCase() === 'PLA'));
  const settings: BrowserPrintSettings =
    selectedSlot === null ? { useAms: false } : { useAms: true, amsMapping: [selectedSlot] };
  const confirmation = `印刷しますか？\n${displayName}${plates.length > 1 ? `\nプレート ${selectedPlate}` : ''}\n供給元: ${selectedSlot === null ? '外部スプール' : `AMS スロット${selectedSlot + 1} · ${selected?.material ?? '材料未取得'} · ${selected?.color ?? '色未取得'}`}\nスライス設定: Generic PLA\nベッドレベリング: 有効\nベッドが空で、材料とプレートが合っていることを確認してください。`;
  async function download() {
    try {
      const response = await fetchPreview(`/preview/${uuid}/download`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download =
        displayName && file
          ? `${displayName.replace(/\.(stl|step|stp)$/i, '')}.${file.format}`
          : (file?.name ?? `${uuid}.gcode.3mf`);
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <>
      <div className="model-area">
        {text ? (
          <Suspense
            fallback={
              <div className="empty-view" role="status">
                読み込み中…
              </div>
            }
          >
            <Viewer key={previewId} text={text} onReady={onViewerReady} />
          </Suspense>
        ) : (
          <div className="empty-view">
            <span className="empty-icon">◈</span>
            <h1>プレビュー</h1>
            {!validUuid ? (
              <p className="error" role="alert">
                プレビューのURLを確認してください。
              </p>
            ) : loading ? (
              <p role="status">読み込み中…</p>
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
      <aside
        className="sidebar"
        ref={sidebar}
        style={{ minHeight: `max(100%, ${sidebarHeight}px)` }}
      >
        <h2>{displayName || (loading ? '読み込み中…' : '—')}</h2>
        {file && <span className="format-tag">{file.format.toUpperCase()}</span>}
        <div className="stats">
          <div>
            <span>推定時間</span>
            <strong>{duration(file?.estimatedSeconds ?? null)}</strong>
          </div>
          <div>
            <span>フィラメント</span>
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
        {file && (
          <details className="preview-ids">
            <summary>ID</summary>
            <dl>
              <dt>プレート</dt>
              <dd>
                <Link to="/preview/$plateId" params={{ plateId }} reloadDocument>
                  {plateId}
                </Link>
              </dd>
              <dt>プレビュー</dt>
              <dd>{previewId}</dd>
            </dl>
          </details>
        )}
        <div className="machine-card">
          <span>プリンター</span>
          <strong>Bambu Lab A1 mini</strong>
          <small>0.4 mm ノズル · 180 mm プレート</small>
        </div>
        <div className="print-panel">
          {file && printerEnabled && (
            <AmsSettings
              status={printerStatus}
              loading={statusLoading}
              error={statusError}
              selected={selectedSlot}
              disabled={settingsLocked}
              onSelect={setSelectedSlot}
              onRefresh={() => setRefresh((n) => n + 1)}
            />
          )}
          <button
            className="print-button"
            disabled={
              !ready ||
              !printerEnabled ||
              (!validSupply &&
                !(
                  printState.key &&
                  (!printState.operation || printState.operation.state === 'pending')
                )) ||
              printState.busy ||
              printState.operation?.state === 'accepted' ||
              printState.operation?.state === 'unknown'
            }
            onClick={() => void controller.start(previewId || uuid, settings, confirmation)}
          >
            {printState.busy
              ? '送信中…'
              : printState.operation?.state === 'accepted'
                ? '受付済み'
                : printState.operation?.state === 'unknown'
                  ? '結果不明'
                  : printState.operation?.state === 'failed'
                    ? '再試行'
                    : printState.key
                      ? '結果を確認'
                      : '印刷'}
          </button>
          {printState.message && (
            <p
              className={`print-message ${printState.operation?.state === 'accepted' ? 'success' : ''}`}
              role="status"
            >
              {printState.message}
            </p>
          )}
        </div>
        {file && (
          <button className="secondary" onClick={() => void download()}>
            ダウンロード
          </button>
        )}
      </aside>
    </>
  );
}
