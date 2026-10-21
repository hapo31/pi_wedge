import { fetchPreview, readLimitedText } from './api.js';
import type { HistoryPage, PreviewData, PrinterStatus } from './api.js';

// Loader migration candidates. These GET functions own transport only; component
// effects currently own their lifetime. Pass the route loader's abortController.signal
// when migrating, and include plateId/previewId (or history query/cursor) in its key.
// Keep fetchPreview's bounded GET-only preview_busy/503 retry and G-code's 32 MiB
// streaming limit. Do not preload/cache large G-code or all plate texts: one active
// plate avoids retaining several decoded strings and WebGL toolpaths on the Pi.
// Metadata/list cache lifetime must be explicit: ready files are immutable, but
// plate membership and printerEnabled can change after server-side updates. The
// current /data combines the set list and selected-plate 3MF statistics, so moving
// it to a parent-only loader would reuse the wrong plate's statistics; split that
// endpoint first or keep this GET in a child loader keyed by both route parameters.
// Printer snapshots must stay fresh on entry/explicit refresh, not reuse a long
// metadata cache. Thumbnail blob URLs belong to the mounted layout and must be
// revoked there. Downloads are click-triggered. Print POST/confirmation/idempotency
// stay in PrintController and must never move to a loader, preload, or GET retry.
function selectionQuery(previewId: string) {
  return previewId ? `?previewId=${encodeURIComponent(previewId)}` : '';
}

export async function getPreviewData(plateId: string, previewId: string, signal: AbortSignal) {
  const response = await fetchPreview(`/preview/${plateId}/data${selectionQuery(previewId)}`, {
    signal,
  });
  const data = (await response.json()) as PreviewData;
  signal.throwIfAborted();
  return data;
}

export async function getPreviewText(plateId: string, previewId: string, signal: AbortSignal) {
  const response = await fetchPreview(`/preview/${plateId}/gcode${selectionQuery(previewId)}`, {
    signal,
  });
  const text = await readLimitedText(response, signal);
  signal.throwIfAborted();
  return text;
}

export async function getPrinterStatus(plateId: string, signal: AbortSignal) {
  const response = await fetchPreview(`/preview/${plateId}/printer`, { signal });
  const status = (await response.json()) as PrinterStatus;
  signal.throwIfAborted();
  return status;
}

export async function getThumbnail(plateId: string, previewId: string, signal: AbortSignal) {
  const response = await fetchPreview(`/preview/${plateId}/thumbnail${selectionQuery(previewId)}`, {
    signal,
  });
  const blob = await response.blob();
  signal.throwIfAborted();
  return blob;
}

// A future history loader should expose q/cursor via validated search/loaderDeps;
// pagination appends belong to the current query and must abort on query changes.
export async function getHistoryPage(query: string, cursor: string | null, signal: AbortSignal) {
  const search = new URLSearchParams();
  if (query) search.set('q', query);
  if (cursor) search.set('cursor', cursor);
  const response = await fetchPreview(`/history/data${search.size ? `?${search}` : ''}`, {
    signal,
  });
  const page = (await response.json()) as HistoryPage;
  signal.throwIfAborted();
  return page;
}
