import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { parsePrinterStatus } from '../src/adapters/printer-status.js';
import { BambuLanPrinter } from '../src/adapters/printer.js';
import type { MqttConnector } from '../src/adapters/printer.js';
import { PrintOptionsSchema, SliceOptionsSchema } from '../src/domain/schemas.js';
import { PrintController } from '../web/src/print-controller.js';
import { readConfig } from '../src/config.js';
import { setup, MODEL, TOKEN, requestJson } from './helpers.js';
const telemetry = {
  gcode_state: 'RUNNING',
  ams: {
    ams_exist_bits: '1',
    tray_exist_bits: '1',
    tray_now: '254',
    ams: [
      {
        id: '0',
        sn: 'private-serial',
        tray: [
          {
            id: '0',
            tray_type: 'PLA',
            tray_color: 'F72323FF',
            remain: 100,
            tray_uuid: 'private-rfid',
          },
          { id: '1' },
          { id: '2' },
          { id: '3' },
        ],
      },
    ],
  },
};
const contexts: Array<Awaited<ReturnType<typeof setup>>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const c of contexts.splice(0)) await c.close();
});
async function context() {
  const c = await setup();
  contexts.push(c);
  c.config.PRINTER_ENABLED = true;
  vi.mocked(c.adapter.readStatus).mockResolvedValue(parsePrinterStatus(telemetry));
  const m = await c.files.upload(new File([MODEL], 'sample.stl'));
  const job = c.jobs.create(m.id, SliceOptionsSchema.parse({}));
  await c.jobs.idle();
  return { c, model: m.id, id: c.jobs.get(job.id).resultFileId! };
}
function browser(settings: unknown, key = randomUUID()): RequestInit {
  return {
    method: 'POST',
    headers: {
      Origin: 'http://localhost',
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(settings),
  };
}
describe('AMS Lite state and print selection', () => {
  it('normalizes real A1 mini slot telemetry and exposes no identity or RFID', () => {
    const status = parsePrinterStatus(telemetry);
    expect(status).toMatchObject({
      amsConnected: true,
      currentSlot: null,
      externalSpoolActive: true,
      slots: [
        { slot: 0, material: 'PLA', color: '#F72323', present: true, remainingPercent: 100 },
        { slot: 1, present: false },
        { slot: 2, present: false },
        { slot: 3, present: false },
      ],
    });
    expect(JSON.stringify(status)).not.toContain('private-');
    expect(parsePrinterStatus({ ams: { ams_exist_bits: '0', tray_now: '255' } })).toMatchObject({
      amsConnected: false,
      slots: [],
      currentSlot: null,
    });
    const unknown = parsePrinterStatus({
      ams: {
        ams: [
          { id: '0', tray: [{ id: '0', tray_type: 'PLA', tray_color: 'invalid', remain: -1 }] },
        ],
      },
    });
    expect(unknown.slots[0]).toMatchObject({ present: null, color: null, remainingPercent: null });
    expect(parsePrinterStatus({}).amsConnected).toBeNull();
  });
  it('only sends a read-only pushall status query and closes the MQTT connection', async () => {
    const client = Object.assign(new EventEmitter(), {
      subscribeAsync: vi.fn(async () => []),
      endAsync: vi.fn(async () => {}),
      publishAsync: vi.fn(async (_topic: string, data: string) => {
        expect(JSON.parse(data)).toEqual({ pushing: { sequence_id: '0', command: 'pushall' } });
        queueMicrotask(() =>
          client.emit(
            'message',
            'device/SERIAL/report',
            Buffer.from(JSON.stringify({ print: telemetry })),
          ),
        );
      }),
    });
    const adapter = new BambuLanPrinter(
      readConfig({
        API_TOKEN: TOKEN,
        STORAGE_BACKEND: 'local',
        PRINTER_SERIAL: 'SERIAL',
        PRINTER_TIMEOUT_MS: '1000',
      }),
      vi.fn(async () => client) as unknown as MqttConnector,
    );
    expect((await adapter.readStatus()).slots[0]?.color).toBe('#F72323');
    expect(client.publishAsync).toHaveBeenCalledOnce();
    expect(client.endAsync).toHaveBeenCalledOnce();
    expect(client.listenerCount('message')).toBe(0);
  });
  it('authenticates agent status, bounds browser access to ready slice UUIDs and coalesces reads', async () => {
    const { c, id, model } = await context();
    expect((await c.app.request('/api/printer/status')).status).toBe(401);
    const [agent, preview] = await Promise.all([
      c.app.request('/api/printer/status', { headers: { Authorization: `Bearer ${TOKEN}` } }),
      c.app.request(`/preview/${id}/printer`),
    ]);
    expect(agent.status).toBe(200);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ slots: [{ material: 'PLA' }, {}, {}, {}] });
    expect((await c.app.request(`/preview/${model}/printer`)).status).toBe(409);
    expect((await c.app.request(`/preview/${randomUUID()}/printer`)).status).toBe(404);
    expect(c.adapter.readStatus).toHaveBeenCalledOnce();
    expect(c.adapter.startPrint).not.toHaveBeenCalled();
    expect(c.adapter.upload).not.toHaveBeenCalled();
  });
  it('passes the selected slot, keeps same-key repeats read-only and rejects changed settings', async () => {
    const { c, id } = await context(),
      key = randomUUID(),
      path = `/preview/${id}/print`;
    const response = await c.app.request(path, browser({ useAms: true, amsMapping: [0] }, key));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: 'accepted',
      options: { useAms: true, amsMapping: [0] },
    });
    await c.app.request(path, browser({ useAms: true, amsMapping: [0] }, key));
    expect(c.adapter.startPrint).toHaveBeenCalledOnce();
    expect(c.adapter.readStatus).toHaveBeenCalledOnce();
    expect((await c.app.request(path, browser({ useAms: false }, key))).status).toBe(409);
    const spec = await (await c.app.request('/openapi.json')).json();
    expect(spec.paths['/api/printer/print'].post.description).toContain('ユーザーへ提示');
    expect(spec.paths['/api/printer/status'].get.security).toEqual([{ BearerAuth: [] }]);
  });
  it('rejects invalid mappings and empty or incompatible slots without upload or motion', async () => {
    const { c, id } = await context();
    for (const settings of [
      { useAms: true },
      { useAms: true, amsMapping: [-1] },
      { useAms: false, amsMapping: [0] },
      { useAms: true, amsMapping: [0, 1] },
      { useAms: true, amsMapping: [4] },
      { useAms: false, bedLeveling: false },
    ])
      expect((await c.app.request(`/preview/${id}/print`, browser(settings))).status).toBe(400);
    const empty = await c.app.request(
      `/preview/${id}/print`,
      browser({ useAms: true, amsMapping: [1] }),
    );
    expect(await empty.json()).toMatchObject({
      state: 'failed',
      error: { code: 'ams_slot_unavailable' },
    });
    const status = parsePrinterStatus(telemetry);
    status.slots[0]!.material = 'PETG';
    vi.mocked(c.adapter.readStatus).mockResolvedValue(status);
    const mismatch = await c.app.request(
      '/api/printer/print',
      requestJson('POST', { fileId: id, options: { useAms: true, amsMapping: [0] } }, randomUUID()),
    );
    expect(await mismatch.json()).toMatchObject({
      state: 'failed',
      error: { code: 'ams_material_mismatch' },
    });
    expect(c.adapter.upload).not.toHaveBeenCalled();
    expect(c.adapter.startPrint).not.toHaveBeenCalled();
    expect(PrintOptionsSchema.safeParse({ useAms: true, amsMapping: [-1] }).success).toBe(false);
  });
  it('restores exact settings and key after a lost response, and changes key after definite failure', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => storage.set(k, v),
      },
    });
    const id = randomUUID(),
      send = vi.fn(async () => {
        throw new Error('response lost');
      });
    const first = new PrintController(send, vi.fn(), () => true);
    await first.start(id, { useAms: true, amsMapping: [0] });
    const [savedFile, savedKey, savedSettings] = (
      send.mock.calls as unknown as Array<[string, string, unknown]>
    )[0]!;
    expect(savedFile).toBe(id);
    expect(savedSettings).toEqual({ useAms: true, amsMapping: [0] });
    const retry = vi.fn(async () => ({ id: savedKey, state: 'failed' as const, error: null }));
    const restored = new PrintController(retry, vi.fn(), () => true);
    expect(restored.restore(id)).toEqual({ useAms: true, amsMapping: [0] });
    await restored.start(id, { useAms: false });
    expect(retry).toHaveBeenCalledWith(id, savedKey, savedSettings);
    await restored.start(id, { useAms: false });
    expect((retry.mock.calls as unknown as Array<[string, string]>)[1]?.[1]).not.toBe(savedKey);
  });
});
