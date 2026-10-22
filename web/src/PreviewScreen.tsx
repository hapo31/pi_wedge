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
import { useQuery } from '@tanstack/react-query';
import { ApiError, fetchPreview, errorMessage } from './api.js';
import { previewDataOptions, previewTextOptions, printerStatusOptions } from './query-options.js';
import { usePreviewLayout } from './App.js';
import type { Operation } from './api.js';
import { AmsSettings } from './AmsSettings.js';
import type { BrowserPrintSettings } from './api.js';
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
  const metadata = useQuery(previewDataOptions(uuid, previewId));
  const data = metadata.data;
  const file = data?.file;
  const displayName = data?.displayName ?? '';
  const plates = data?.plates ?? [];
  const selectedPlate = data?.plate ?? 1;
  const plateId = data?.plateId ?? uuid;
  const printerEnabled = data?.printerEnabled === true;
  const textQuery = useQuery({
    ...previewTextOptions(uuid, previewId),
    enabled: metadata.isSuccess,
  });
  const statusQuery = useQuery({
    ...printerStatusOptions(uuid, previewId),
    enabled: metadata.isSuccess && printerEnabled,
  });
  const text = textQuery.data ?? '';
  const loading = textQuery.isPending && !textQuery.isError;
  const printerStatus = statusQuery.isError ? null : (statusQuery.data ?? null);
  const statusLoading = statusQuery.isFetching;
  const statusError = statusQuery.error ? errorMessage(statusQuery.error) : '';
  const [downloadError, setDownloadError] = useState('');
  const error = downloadError || (textQuery.error ? errorMessage(textQuery.error) : '');
  const [ready, setReady] = useState(false),
    [printState, setPrintState] = useState<PrintState>(INITIAL),
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
    if (data) updatePreview(data);
  }, [data, updatePreview]);
  useEffect(() => {
    const saved = controller.restore(previewId || uuid);
    setSelectedSlot(saved.useAms ? (saved.amsMapping?.[0] ?? null) : null);
  }, [controller, previewId, uuid]);
  useEffect(() => {
    setPrintBusy(printState.busy);
    return () => setPrintBusy(false);
  }, [printState.busy, setPrintBusy]);
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
      setDownloadError(errorMessage(e));
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
            {loading ? (
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
              onRefresh={() => void statusQuery.refetch()}
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
