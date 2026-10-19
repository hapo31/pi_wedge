import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setup, MODEL, TOKEN, requestJson } from './helpers.js';
import { SliceOptionsSchema } from '../src/domain/schemas.js';

const contexts: Array<Awaited<ReturnType<typeof setup>>> = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.close();
});
async function context() {
  const value = await setup();
  contexts.push(value);
  return value;
}

describe('LAN slice history', () => {
  it('lists only ready slice summaries without a token and uses the supplied JSON name', async () => {
    const c = await context();
    const model = await c.files.upload(new File([MODEL], 'source.stl'));
    const created = await c.app.request(
      '/api/slices',
      requestJson('POST', { fileId: model.id, name: '  収納ケースのふた  ' }),
    );
    expect(created.status).toBe(202);
    const job = await created.json();
    expect(job.name).toBe('収納ケースのふた');
    await c.jobs.idle();
    const resultId = c.jobs.get(job.id).resultFileId;
    const response = await c.app.request('/history/data');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      items: [
        expect.objectContaining({
          id: resultId,
          name: '収納ケースのふた',
          estimatedSeconds: 62,
          filamentGrams: 1.2,
        }),
      ],
      nextCursor: null,
    });
    expect((await (await c.app.request(`/preview/${resultId}/data`)).json()).displayName).toBe(
      '収納ケースのふた',
    );
    expect((await (await c.app.request('/history/data?q=収納')).json()).items).toHaveLength(1);
    expect((await (await c.app.request('/history/data?q=source')).json()).items).toHaveLength(1);
    expect((await (await c.app.request('/history/data?q=missing')).json()).items).toHaveLength(0);
    expect((await c.app.request('/history/data?q=%20')).status).toBe(400);
    expect(c.adapter.startPrint).not.toHaveBeenCalled();
  });

  it('accepts multipart names, falls back for old slices, and rejects invalid names', async () => {
    const c = await context();
    const form = new FormData();
    form.set('file', new File([MODEL], 'multipart.stl'));
    form.set('name', '試作品 2');
    const created = await c.app.request('/api/slices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    expect(created.status).toBe(202);
    expect((await created.json()).name).toBe('試作品 2');
    await c.jobs.idle();
    const oldModel = await c.files.upload(new File([MODEL], 'older.stl'));
    const oldJob = c.jobs.create(oldModel.id, SliceOptionsSchema.parse({}));
    await c.jobs.idle();
    expect(
      (await (await c.app.request('/history/data')).json()).items.map(
        (item: { name: string }) => item.name,
      ),
    ).toEqual(['older.stl', '試作品 2']);
    for (const name of ['', ' '.repeat(3), 'x'.repeat(81), 'bad\nname']) {
      expect(
        (await c.app.request('/api/slices', requestJson('POST', { fileId: oldModel.id, name })))
          .status,
      ).toBe(400);
      form.set('name', name);
      expect(
        (
          await c.app.request('/api/slices', {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}` },
            body: form,
          })
        ).status,
      ).toBe(400);
    }
    const oldResult = c.repository.get('file', c.jobs.get(oldJob.id).resultFileId!);
    expect(oldResult?.displayName).toBeUndefined();
  });

  it('paginates in newest-first order and excludes failed/staging/model records', async () => {
    const c = await context();
    const model = await c.files.upload(new File([MODEL], 'part.stl'));
    const resultIds: string[] = [];
    for (let index = 0; index < 26; index++) {
      const job = c.jobs.create(model.id, SliceOptionsSchema.parse({}), `版 ${index}`);
      await c.jobs.idle();
      const resultId = c.jobs.get(job.id).resultFileId!;
      const result = c.repository.get('file', resultId)!;
      result.createdAt = new Date(Date.UTC(2026, 9, 19, 0, 0, index)).toISOString();
      c.repository.save('file', result);
      resultIds.push(resultId);
    }
    const first = await (await c.app.request('/history/data')).json();
    expect(first.items).toHaveLength(24);
    expect(first.items[0].id).toBe(resultIds[25]);
    expect(first.nextCursor).toBe(first.items[23].id);
    const second = await (await c.app.request(`/history/data?cursor=${first.nextCursor}`)).json();
    expect(second.items.map((item: { id: string }) => item.id)).toEqual(
      resultIds.slice(0, 2).reverse(),
    );
    expect(second.nextCursor).toBeNull();
    expect((await (await c.app.request('/history/data?q=%E7%89%88')).json()).items).toHaveLength(
      24,
    );
    expect((await c.app.request('/history/data?cursor=invalid')).status).toBe(400);
    expect((await c.app.request(`/history/data?cursor=${randomUUID()}`)).status).toBe(404);
    expect((await c.app.request('/history/data?unexpected=1')).status).toBe(400);
    expect((await c.app.request(`/history/data?cursor=${model.id}`)).status).toBe(409);
  });

  it('documents the public history and optional slice name', async () => {
    const c = await context();
    const spec = await (await c.app.request('/openapi.json')).json();
    expect(spec.paths['/history/data'].get.security).toEqual([]);
    expect(spec.paths['/history/data'].get.operationId).toBe('listBrowserSliceHistory');
    expect(spec.paths['/history'].get.security).toEqual([]);
    const bodies = spec.paths['/api/slices'].post.requestBody.content;
    expect(JSON.stringify(bodies['application/json'].schema)).toContain('name');
    expect(JSON.stringify(bodies['multipart/form-data'].schema)).toContain('name');
  });
});
