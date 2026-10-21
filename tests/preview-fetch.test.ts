import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchPreview } from '../web/src/api.js';

const busy = () =>
  Response.json({ error: { code: 'preview_busy', message: 'busy' } }, { status: 503 });
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('retries a busy preview GET until the old plate processing slots are released', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(busy())
    .mockResolvedValueOnce(busy())
    .mockResolvedValueOnce(new Response('ready'));
  vi.stubGlobal('fetch', fetch);
  const result = fetchPreview('/preview/group/data?previewId=next');
  await vi.advanceTimersByTimeAsync(750);
  expect(await (await result).text()).toBe('ready');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('cancels the retry wait when the selected preview changes', async () => {
  const fetch = vi.fn(async () => busy());
  vi.stubGlobal('fetch', fetch);
  const abort = new AbortController();
  const result = expect(
    fetchPreview('/preview/group/data', { signal: abort.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await result;
  await vi.runAllTimersAsync();
  expect(fetch).toHaveBeenCalledOnce();
});

it('bounds busy retries and never retries print POSTs or unrelated failures', async () => {
  const fetch = vi.fn(async () => busy());
  vi.stubGlobal('fetch', fetch);
  const exhausted = expect(fetchPreview('/preview/group/data')).rejects.toMatchObject({
    code: 'preview_busy',
  });
  await vi.runAllTimersAsync();
  await exhausted;
  expect(fetch).toHaveBeenCalledTimes(31);
  fetch.mockClear();
  await expect(fetchPreview('/preview/group/print', { method: 'POST' })).rejects.toMatchObject({
    code: 'preview_busy',
  });
  expect(fetch).toHaveBeenCalledOnce();
  fetch
    .mockReset()
    .mockImplementation(async () =>
      Response.json({ error: { code: 'storage_unavailable' } }, { status: 503 }),
    );
  await expect(fetchPreview('/preview/group/data')).rejects.toMatchObject({
    code: 'storage_unavailable',
  });
  expect(fetch).toHaveBeenCalledOnce();
});
