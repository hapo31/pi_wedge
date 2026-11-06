import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrintController } from '../web/src/print-controller.js';
import type { BrowserPrintSettings } from '../web/src/api.js';

afterEach(() => vi.unstubAllGlobals());

it.each(['pending', 'lost response'] as const)(
  'reuses the persisted key and supply after a reload with %s',
  async (outcome) => {
    const saved = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => saved.set(key, value),
      },
    });
    const id = randomUUID();
    const settings: BrowserPrintSettings = { useAms: true, amsMapping: [1] };
    const send = vi.fn(async (_id: string, key: string, supplied: BrowserPrintSettings) => {
      // The request must already survive a reload when dispatch begins.
      expect(JSON.parse(saved.get(`pi_wedge:print:${id}`)!)).toMatchObject({
        key,
        settings: supplied,
      });
      if (outcome === 'lost response') throw new Error('response lost');
      return { id: key, state: 'pending' as const, error: null };
    });
    await new PrintController(send, vi.fn(), () => true).start(id, settings);
    const key = send.mock.calls[0]![1];
    const restored = new PrintController(send, vi.fn(), () => true);
    expect(restored.restore(id)).toEqual(settings);
    await restored.start(id, { useAms: false });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual([id, key, settings]);
  },
);

it('does not dispatch when the request cannot be saved before sending', async () => {
  vi.stubGlobal('window', {
    localStorage: {
      setItem: () => {
        throw new Error('storage unavailable');
      },
    },
  });
  const send = vi.fn();
  const update = vi.fn();
  await new PrintController(send, update, () => true).start(randomUUID());
  expect(send).not.toHaveBeenCalled();
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ busy: false, message: expect.stringContaining('保存できません') }),
  );
});
