import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setup, MODEL, TOKEN, requestJson } from './helpers.js';
import { FileSchema, JobSchema, SliceOptionsSchema } from '../src/domain/schemas.js';
const contexts: Array<Awaited<ReturnType<typeof setup>>> = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
async function ctx() {
  const c = await setup();
  contexts.push(c);
  return c;
}
describe('API validation and OpenAPI contract', () => {
  it('requires authentication for all data, rejects malformed UUID/JSON/unknown fields', async () => {
    const c = await ctx();
    expect((await c.app.request('/api/files/' + randomUUID())).status).toBe(401);
    expect(
      (await c.app.request('/api/files/no-uuid', { headers: { Authorization: `Bearer ${TOKEN}` } }))
        .status,
    ).toBe(400);
    expect(
      (
        await c.app.request('/api/files/' + randomUUID(), {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await c.app.request(
          '/api/slices',
          requestJson('POST', { fileId: randomUUID(), options: { layerHeight: -1 } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await c.app.request(
          '/api/slices',
          requestJson('POST', { fileId: randomUUID(), evil: true }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await c.app.request('/api/printer/print', requestJson('POST', { fileId: randomUUID() })))
        .status,
    ).toBe(400);
  });
  it('accepts multipart models then JSON async slices, returns no G-code', async () => {
    const c = await ctx(),
      form = new FormData();
    form.set('file', new File([MODEL], 'part.stl'));
    const upload = await c.app.request('/api/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    expect(upload.status).toBe(201);
    const model = FileSchema.parse(await upload.json());
    const created = await c.app.request('/api/slices', requestJson('POST', { fileId: model.id }));
    expect(created.status).toBe(202);
    const job = JobSchema.parse(await created.json());
    expect(created.headers.get('Location')).toBe(`/api/slices/${job.id}`);
    expect(job.state).toBe('queued');
    await c.jobs.idle();
    const poll = await c.app.request(`/api/slices/${job.id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const done = JobSchema.parse(await poll.json());
    expect(done.state).toBe('succeeded');
    expect(
      (
        await c.app.request(`/api/files/${done.resultFileId}/download`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(200);
    expect(c.adapter.startPrint).not.toHaveBeenCalled();
  });
  it('accepts file plus JSON-string options and rejects malformed multipart options', async () => {
    const c = await ctx(),
      form = new FormData();
    form.set('file', new File([MODEL], 'part.stl'));
    form.set('options', '{"infillDensity":25}');
    const r = await c.app.request('/api/slices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    expect(r.status).toBe(202);
    expect((await r.json()).options.infillDensity).toBe(25);
    await c.jobs.idle();
    form.set('options', '{"settings":{"machine_start_gcode":"unsafe"}}');
    const bad = await c.app.request('/api/slices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    expect(bad.status).toBe(400);
  });
  it('enforces upload size and model format before storage', async () => {
    const c = await ctx(),
      form = new FormData();
    form.set('file', new File(['not stl'], 'x.stl'));
    expect(
      (
        await c.app.request('/api/files', {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}` },
          body: form,
        })
      ).status,
    ).toBe(400);
    form.set('file', new File(['x'], 'x.exe'));
    expect(
      (
        await c.app.request('/api/files', {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}` },
          body: form,
        })
      ).status,
    ).toBe(415);
    form.set('file', new File([new Uint8Array(1200000)], 'x.stl'));
    expect(
      (
        await c.app.request('/api/files', {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}` },
          body: form,
        })
      ).status,
    ).toBe(413);
  });
  it('documents both slice content types, Bearer auth, idempotency and physical effect', async () => {
    const c = await ctx(),
      spec = await (await c.app.request('/openapi.json')).json();
    expect(spec.openapi).toBe('3.1.0');
    const endpoints = [
      '/api/ready',
      '/api/profiles',
      '/api/files',
      '/api/files/{uuid}',
      '/api/files/{uuid}/download',
      '/api/slices',
      '/api/slices/{jobId}',
      '/api/printer/upload',
      '/api/printer/print',
      '/api/printer/operations/{operationId}',
    ];
    for (const path of endpoints) {
      const item = spec.paths[path];
      expect(item).toBeDefined();
      for (const operation of Object.values(item) as Array<{
        security: unknown;
        operationId: string;
        responses: Record<string, unknown>;
        description: string;
      }>) {
        expect(operation.security).toEqual([{ BearerAuth: [] }]);
        expect(operation.operationId).toBeTruthy();
        expect(operation.responses['401']).toBeDefined();
        expect(operation.description.length).toBeGreaterThan(30);
      }
    }
    expect(Object.keys(spec.paths['/api/slices'].post.requestBody.content)).toEqual([
      'application/json',
      'multipart/form-data',
    ]);
    expect(spec.paths['/api/printer/print'].post.description).toContain('PHYSICAL SIDE EFFECT');
    expect(spec.paths['/api/printer/print'].post.parameters).toContainEqual(
      expect.objectContaining({ in: 'header', name: 'Idempotency-Key', required: true }),
    );
  });
  it('starts printing only via the authenticated explicit API and exposes persisted operation', async () => {
    const c = await ctx(),
      f = await c.files.upload(new File([MODEL], 'a.stl')),
      j = c.jobs.create(f.id, SliceOptionsSchema.parse({}));
    await c.jobs.idle();
    const fileId = c.jobs.get(j.id).resultFileId!,
      key = randomUUID();
    const r = await c.app.request('/api/printer/print', requestJson('POST', { fileId }, key));
    expect(r.status).toBe(200);
    expect((await r.json()).state).toBe('accepted');
    await c.app.request('/api/printer/print', requestJson('POST', { fileId }, key));
    expect(c.adapter.startPrint).toHaveBeenCalledOnce();
    expect(
      (
        await c.app.request(`/api/printer/operations/${key}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        })
      ).status,
    ).toBe(200);
  });
});
