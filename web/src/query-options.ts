import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import {
  getHistoryPage,
  getPreviewData,
  getPreviewText,
  getPrinterStatus,
  getThumbnail,
} from './preview-queries.js';
import { SerialFetch } from './serial-fetch.js';

const uuid = z.string().uuid();
export function validateSelection(plateId: string, previewId = '') {
  if (!uuid.safeParse(plateId).success || (previewId && !uuid.safeParse(previewId).success))
    throw new Error('プレビューのURLを確認してください。');
}

const historySearch = z
  .object({
    q: z
      .string()
      .trim()
      .max(80)
      .refine(
        (value) =>
          ![...value].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ),
      )
      .optional(),
  })
  .strict();
export function validateHistorySearch(value: unknown) {
  const parsed = historySearch.safeParse(value);
  if (!parsed.success) throw new Error('検索条件を確認してください。');
  return parsed.data.q ? { q: parsed.data.q } : {};
}

export function previewDataOptions(plateId: string, previewId = '') {
  return queryOptions({
    queryKey: ['preview-data', plateId, previewId],
    queryFn: ({ signal }) => getPreviewData(plateId, previewId, signal),
    staleTime: 0,
    // Keep small metadata through the loader-to-component handoff only.
    gcTime: 30_000,
    refetchOnMount: false,
  });
}

export function previewTextOptions(plateId: string, previewId = '') {
  return queryOptions({
    queryKey: ['preview-text', plateId, previewId],
    queryFn: ({ signal }) => getPreviewText(plateId, previewId, signal),
    staleTime: Infinity,
    gcTime: 0,
  });
}

export function printerStatusOptions(plateId: string, previewId = '') {
  return queryOptions({
    queryKey: ['printer-status', plateId, previewId],
    queryFn: ({ signal }) => getPrinterStatus(plateId, signal),
    staleTime: 0,
    gcTime: 0,
  });
}

export function historyOptions(query: string) {
  return infiniteQueryOptions({
    queryKey: ['history', query],
    queryFn: ({ pageParam, signal }) => getHistoryPage(query, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 0,
    gcTime: 0,
  });
}

const thumbnails = new SerialFetch();
export function thumbnailOptions(plateId: string, previewId: string) {
  return queryOptions({
    queryKey: ['thumbnail', plateId, previewId],
    queryFn: ({ signal }) => thumbnails.run(signal, () => getThumbnail(plateId, previewId, signal)),
    staleTime: Infinity,
    gcTime: 0,
    structuralSharing: false,
  });
}
