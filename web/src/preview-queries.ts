import { fetchPreview, readLimitedText } from './api.js';
import type { HistoryPage, PreviewData, PrinterStatus } from './api.js';

// Transport only. Query owns requests/signals; Router loaders lease metadata.
// Keep GET-only preview_busy retries and the 32 MiB decompressed text limit.
// Large text is observed only by the active child and never preloaded/persisted.
// /data combines membership and selected-plate statistics: key by both UUIDs.
// Object URLs and PrintController remain owned by mounted components.
function selectionQuery(previewId: string) {
  return previewId ? `?previewId=${encodeURIComponent(previewId)}` : '';
}

export async function getPreviewData(plateId: string, previewId: string, signal: AbortSignal) {
  const response = await fetchPreview(`/preview/${plateId}/data${selectionQuery(previewId)}`, {
    signal,
  });
  const data = (await response.json()) as PreviewData;
  signal.throwIfAborted();
  if (data.file.state !== 'ready' || !['gcode', 'gcode.3mf'].includes(data.file.format))
    throw new Error('このファイルはプレビューできません。');
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

// Search is validated URL state; cursor belongs to the infinite query's pageParam.
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
