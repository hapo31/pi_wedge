import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setup, MODEL, GCODE } from './helpers.js';
import { SliceOptionsSchema } from '../src/domain/schemas.js';

const contexts: Array<Awaited<ReturnType<typeof setup>>> = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
async function context() {
  const c = await setup();
  contexts.push(c);
  const model = await c.files.upload(new File([MODEL], 'measuring_cup.stl'));
  const job = c.jobs.create(model.id, SliceOptionsSchema.parse({}));
  await c.jobs.idle();
  return { c, model, id: c.jobs.get(job.id).resultFileId! };
}
const printRequest = (
  key: string = randomUUID(),
  origin: string | undefined = 'http://localhost',
  body?: string,
): RequestInit => ({
  method: 'POST',
  headers: { 'Idempotency-Key': key, ...(origin ? { Origin: origin } : {}) },
  ...(body === undefined ? {} : { body }),
});

describe('simple trusted LAN browser preview', () => {
  it('loads one slice without a token, protects models and agent APIs, and never starts printing on read', async () => {
    const { c, model, id } = await context();
    const data = await c.app.request(`/preview/${id}/data`);
    expect(data.status).toBe(200);
    expect(data.headers.get('Cache-Control')).toBe('no-store');
    expect(await data.json()).toMatchObject({
      displayName: 'measuring_cup.stl',
      file: { id },
      printerEnabled: false,
    });
    const gcode = await c.app.request(`/preview/${id}/gcode`);
    expect(gcode.status).toBe(200);
    expect(await gcode.text()).toBe(GCODE);
    const download = await c.app.request(`/preview/${id}/download`);
    expect(download.status).toBe(200);
    expect((await download.arrayBuffer()).byteLength).toBe(c.files.ready(id).size);
    for (const action of ['data', 'gcode', 'download']) {
      expect((await c.app.request(`/preview/${model.id}/${action}`)).status).toBe(409);
      expect((await c.app.request(`/preview/${randomUUID()}/${action}`)).status).toBe(404);
      expect((await c.app.request(`/preview/invalid/${action}`)).status).toBe(400);
    }
    expect((await c.app.request(`/api/files/${id}`)).status).toBe(401);
    expect((await c.app.request('/api/slices', { method: 'POST' })).status).toBe(401);
    expect((await c.app.request('/api/printer/print', { method: 'POST' })).status).toBe(401);
    expect(c.adapter.upload).not.toHaveBeenCalled();
    expect(c.adapter.startPrint).not.toHaveBeenCalled();
  });
  it('rejects missing/cross-origin print requests, invalid keys, bodies and disabled printers before dispatch', async () => {
    const { c, id } = await context();
    const path = `/preview/${id}/print`;
    for (const origin of [undefined, 'http://elsewhere.example', 'null']) {
      const request = printRequest();
      if (origin === undefined) delete (request.headers as Record<string, string>).Origin;
      else (request.headers as Record<string, string>).Origin = origin;
      expect((await c.app.request(path, request)).status).toBe(403);
    }
    const preflight = await c.app.request(path, {
      method: 'OPTIONS',
      headers: { Origin: 'http://elsewhere.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect((await c.app.request(path, printRequest('invalid'))).status).toBe(400);
    expect(
      (await c.app.request(path, printRequest(randomUUID(), 'http://localhost', '{}'))).status,
    ).toBe(400);
    expect(
      (await c.app.request(path, printRequest(randomUUID(), 'http://localhost', 'x'.repeat(2048))))
        .status,
    ).toBe(413);
    expect((await c.app.request(path, printRequest())).status).toBe(503);
    expect(c.adapter.startPrint).not.toHaveBeenCalled();
    expect(c.repository.all('operation')).toHaveLength(0);
  });
  it('uses the existing printer service and persistent idempotency key after explicit same-origin print', async () => {
    const { c, id } = await context();
    c.config.PRINTER_ENABLED = true;
    const key = randomUUID();
    const first = await c.app.request(`/preview/${id}/print`, printRequest(key));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ id: key, fileId: id, state: 'accepted' });
    const repeated = await c.app.request(`/preview/${id}/print`, printRequest(key));
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).id).toBe(key);
    expect(c.adapter.startPrint).toHaveBeenCalledOnce();
    expect(c.adapter.upload).toHaveBeenCalledOnce();
  });
  it('documents browser access separately from authenticated agent API with origin and idempotency requirements', async () => {
    const { c } = await context();
    const spec = await (await c.app.request('/openapi.json')).json();
    for (const action of ['data', 'gcode', 'download', 'print']) {
      const route = spec.paths[`/preview/{uuid}/${action}`][action === 'print' ? 'post' : 'get'];
      expect(route.security).toEqual([]);
      expect(route.operationId).toBeTruthy();
      expect(route.responses['400']).toBeDefined();
    }
    const print = spec.paths['/preview/{uuid}/print'].post;
    expect(print.responses['403']).toBeDefined();
    expect(print.description).toContain('PHYSICAL SIDE EFFECT');
    for (const name of ['Origin', 'Idempotency-Key'])
      expect(print.parameters).toContainEqual(
        expect.objectContaining({ in: 'header', name, required: true }),
      );
    expect(spec.paths['/api/printer/print'].post.security).toEqual([{ BearerAuth: [] }]);
  });
});
