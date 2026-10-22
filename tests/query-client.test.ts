import { afterEach, expect, it, vi } from 'vitest';
import { InfiniteQueryObserver, QueryObserver } from '@tanstack/react-query';
import { createQueryClient, loadQuery } from '../web/src/query-client.js';
import {
  historyOptions,
  previewDataOptions,
  previewTextOptions,
  validateHistorySearch,
  validateSelection,
} from '../web/src/query-options.js';
import { SerialFetch } from '../web/src/serial-fetch.js';

const plate = 'b8979c43-b9a6-4d6d-a733-7347800130af';
const first = '0198cdf0-b8f1-4de0-8d67-000000000001';
const second = '0198cdf0-b8f1-4de0-8d67-000000000002';
const clients: ReturnType<typeof createQueryClient>[] = [];
function client() {
  const next = createQueryClient();
  clients.push(next);
  return next;
}
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function metadata(count = 1) {
  return {
    file: { state: 'ready', format: 'gcode' },
    plates: Array.from({ length: count }, (_, index) => ({
      id: index ? second : first,
      plate: index + 1,
    })),
  };
}
afterEach(() => {
  for (const value of clients.splice(0)) value.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('validates UUIDs and normalizes only supported history searches', () => {
  expect(() => validateSelection(plate, first)).not.toThrow();
  expect(() => validateSelection('../data', first)).toThrow();
  expect(() => validateSelection(plate, 'invalid')).toThrow();
  expect(validateHistorySearch({ q: '  収納  ' })).toEqual({ q: '収納' });
  expect(validateHistorySearch({ q: ' ' })).toEqual({});
  for (const input of [
    { q: 12 },
    { q: ['a'] },
    { q: 'x'.repeat(81) },
    { q: 'a\0b' },
    { cursor: first },
  ])
    expect(() => validateHistorySearch(input)).toThrow('検索条件');
});

it('hands metadata from loader to observer without another GET and refreshes it on reentry', async () => {
  const cache = client();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(metadata()))
    .mockResolvedValueOnce(Response.json(metadata(2)));
  vi.stubGlobal('fetch', fetch);
  const options = previewDataOptions(plate, first);
  await loadQuery(cache, options, new AbortController().signal);
  const observer = new QueryObserver(cache, options);
  const unsubscribe = observer.subscribe(() => {});
  expect(observer.getCurrentResult().data?.plates).toHaveLength(1);
  expect(fetch).toHaveBeenCalledOnce();
  unsubscribe();
  await loadQuery(cache, options, new AbortController().signal);
  expect(cache.getQueryData(options.queryKey)?.plates).toHaveLength(2);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('aborts a superseded loader but preserves a shared loader request', async () => {
  const cache = client();
  const response = gate<Response>();
  let signal!: AbortSignal;
  const fetch = vi.fn((_path: string, init: RequestInit) => {
    signal = init.signal!;
    return response.promise;
  });
  vi.stubGlobal('fetch', fetch);
  const options = previewDataOptions(plate, first);
  const obsolete = new AbortController();
  const old = loadQuery(cache, options, obsolete.signal);
  const oldError = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  const current = loadQuery(cache, options, new AbortController().signal);
  obsolete.abort();
  await oldError;
  expect(signal.aborted).toBe(false);
  response.resolve(Response.json(metadata()));
  await current;
  expect(fetch).toHaveBeenCalledOnce();
});

it('cancels the final loader lease, ignores its late result, and allows a new generation', async () => {
  const cache = client();
  const response = gate<Response>();
  let signal!: AbortSignal;
  const fetch = vi
    .fn()
    .mockImplementationOnce((_path: string, init: RequestInit) => {
      signal = init.signal!;
      return response.promise;
    })
    .mockResolvedValueOnce(Response.json(metadata(2)));
  vi.stubGlobal('fetch', fetch);
  const options = previewDataOptions(plate, first);
  const abort = new AbortController();
  const old = expect(loadQuery(cache, options, abort.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  abort.abort();
  await old;
  expect(signal.aborted).toBe(true);
  await loadQuery(cache, options, new AbortController().signal);
  response.resolve(Response.json(metadata()));
  await Promise.resolve();
  expect(cache.getQueryData(options.queryKey)?.plates).toHaveLength(2);
});

it('cancels busy GET retry waits through Query and does not multiply unrelated retries', async () => {
  vi.useFakeTimers();
  const cache = client();
  const fetch = vi.fn(async () =>
    Response.json({ error: { code: 'preview_busy' } }, { status: 503 }),
  );
  vi.stubGlobal('fetch', fetch);
  const abort = new AbortController();
  const result = expect(
    loadQuery(cache, previewDataOptions(plate, first), abort.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await result;
  await vi.advanceTimersByTimeAsync(2000);
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockImplementation(async () =>
    Response.json({ error: { code: 'storage_unavailable' } }, { status: 503 }),
  );
  await expect(
    loadQuery(cache, previewDataOptions(plate, second), new AbortController().signal),
  ).rejects.toMatchObject({ code: 'storage_unavailable' });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('discards inactive G-code and cancels an unfinished text stream on unsubscribe', async () => {
  vi.useFakeTimers();
  const cache = client();
  let signal!: AbortSignal;
  const fetch = vi.fn(async (_path: string, init: RequestInit) => {
    signal = init.signal!;
    return new Response('G1 X1 E1');
  });
  vi.stubGlobal('fetch', fetch);
  const options = previewTextOptions(plate, first);
  const observer = new QueryObserver(cache, options);
  const unsubscribe = observer.subscribe(() => {});
  await observer.refetch({ cancelRefetch: false });
  expect(cache.getQueryData(options.queryKey)).toBe('G1 X1 E1');
  unsubscribe();
  await vi.advanceTimersByTimeAsync(0);
  expect(cache.getQueryCache().find({ queryKey: options.queryKey })).toBeUndefined();
  let streamAborted = false;
  fetch.mockImplementation(async (_path, init) => {
    signal = init.signal!;
    return new Response(
      new ReadableStream({
        start: (controller) => {
          signal.addEventListener(
            'abort',
            () => {
              streamAborted = true;
              controller.error(signal.reason);
            },
            { once: true },
          );
        },
      }),
    );
  });
  const pending = new QueryObserver(cache, previewTextOptions(plate, second));
  const stop = pending.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  stop();
  expect(signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(streamAborted).toBe(true);
  expect(
    cache.getQueryCache().find({ queryKey: previewTextOptions(plate, second).queryKey }),
  ).toBeUndefined();
});

it('keeps history pages on append failure and isolates a different search', async () => {
  const cache = client();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ items: [{ id: first }], nextCursor: first }))
    .mockResolvedValueOnce(
      Response.json({ error: { code: 'storage_unavailable' } }, { status: 503 }),
    )
    .mockResolvedValueOnce(Response.json({ items: [{ id: second }], nextCursor: null }));
  vi.stubGlobal('fetch', fetch);
  const observer = new InfiniteQueryObserver(cache, historyOptions('収納'));
  const stop = observer.subscribe(() => {});
  await observer.refetch({ cancelRefetch: false });
  await observer.fetchNextPage();
  expect(observer.getCurrentResult().data?.pages.flatMap((page) => page.items)).toEqual([
    { id: first },
  ]);
  expect(observer.getCurrentResult().isFetchNextPageError).toBe(true);
  observer.setOptions(historyOptions('別'));
  await observer.refetch({ cancelRefetch: false });
  expect(observer.getCurrentResult().data?.pages.flatMap((page) => page.items)).toEqual([
    { id: second },
  ]);
  stop();
});

it('serializes thumbnail requests, skips aborted waiters, and continues after a failure', async () => {
  const queue = new SerialFetch();
  const firstGate = gate<void>();
  const calls: number[] = [];
  const firstTask = queue.run(new AbortController().signal, async () => {
    calls.push(1);
    await firstGate.promise;
    throw new Error('thumbnail failed');
  });
  const failure = expect(firstTask).rejects.toThrow('thumbnail failed');
  const abort = new AbortController();
  const skipped = expect(
    queue.run(abort.signal, async () => {
      calls.push(2);
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  const third = queue.run(new AbortController().signal, async () => {
    calls.push(3);
  });
  await Promise.resolve();
  abort.abort();
  await skipped;
  expect(calls).toEqual([1]);
  firstGate.resolve();
  await failure;
  await third;
  expect(calls).toEqual([1, 3]);
});
