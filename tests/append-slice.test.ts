import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { setup, MODEL, GCODE, TOKEN, requestJson } from './helpers.js';
import { SliceOptionsSchema } from '../src/domain/schemas.js';
import { PreviewService } from '../src/services/preview.js';
import { JobService } from '../src/services/jobs.js';
import { Repository } from '../src/adapters/repository.js';
const contexts: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
async function context() {
  const c = await setup();
  contexts.push(c);
  const model = await c.files.upload(new File([MODEL], 'root.stl'));
  const job = c.jobs.create(model.id, SliceOptionsSchema.parse({}), '親');
  await c.jobs.idle();
  const root = c.jobs.get(job.id).resultFileId!;
  const preview = new PreviewService(c.files, c.dir, 1048576);
  const { group } = await preview.selection(root);
  return { c, model, root, group, preview };
}
describe('append slices to a root preview UUID', () => {
  it('accepts JSON/multipart, appends queued siblings to the latest container and preserves original previews', async () => {
    const { c, model, root, group, preview } = await context();
    const slicer = vi.mocked(c.slicer.slice);
    const original = slicer.getMockImplementation()!;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    slicer.mockImplementation(async (...args) => {
      if (args[2]?.plate === 2) await gate;
      return original(...args);
    });
    const originalSize = c.files.ready(root).size;
    const one = await c.app.request(
      '/api/slices',
      requestJson('POST', { fileId: model.id, parentId: root, name: '追加1' }),
    );
    expect(one.status).toBe(202);
    const first = await one.json();
    expect(first.parentId).toBe(root);
    const form = new FormData();
    form.set('file', new File([MODEL], 'added.stl'));
    form.set('parentId', root);
    form.set('name', '追加2');
    const two = await c.app.request('/api/slices', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    });
    expect(two.status).toBe(202);
    const second = await two.json();
    release();
    await c.jobs.idle();
    const done = [first, second].map((j) => c.jobs.get(j.id));
    for (const j of done) {
      expect(j).toMatchObject({ state: 'succeeded', parentId: root, plateId: group.id });
      expect(c.files.ready(j.resultFileId!).parentId).toBe(root);
      expect(c.files.ready(j.resultFileId!).plate).toBe(j.plate);
    }
    const data = await preview.details(group.id);
    expect(data.plates.map((p) => p.id)).toEqual([root, ...done.map((j) => j.resultFileId)]);
    expect(data.plates.map((p) => p.plate)).toEqual([1, 2, 3]);
    expect(c.files.ready(root).size).toBe(originalSize);
    expect(await preview.selectedText(group.id, root)).toBe(GCODE);
    const latest = c.repository.get('plateSet', group.id)!;
    expect(latest.fileId).toBe(done[1]!.resultFileId);
    for (const plate of [1, 2, 3]) expect(await preview.text(latest.fileId, plate)).toBe(GCODE);
    const download = await c.app.request(`/preview/${group.id}/download`);
    expect((await download.arrayBuffer()).byteLength).toBe(c.files.ready(latest.fileId).size);
    const history = await (await c.app.request('/history/data')).json();
    expect(history.items).toHaveLength(3);
    expect(
      history.items.every(
        (i: { plateId: string; plateCount: number }) =>
          i.plateId === group.id && i.plateCount === 3,
      ),
    ).toBe(true);
    expect(c.adapter.upload).not.toHaveBeenCalled();
    expect(c.adapter.startPrint).not.toHaveBeenCalled();
    const reopened = new Repository(join(c.dir, 'metadata.sqlite'));
    expect(reopened.get('plateSet', group.id)?.fileId).toBe(latest.fileId);
    expect(reopened.previews(group.id).map((p) => p.id)).toEqual(data.plates.map((p) => p.id));
    reopened.close();
    expect(await readdir(join(c.dir, 'tmp'))).toEqual([]);
  });
  it('returns BadRequest with the root parentId before uploading when a child is specified', async () => {
    const { c, model, root } = await context();
    const child = await c.jobs.createWithParent(
      model.id,
      SliceOptionsSchema.parse({}),
      undefined,
      root,
    );
    await c.jobs.idle();
    const id = c.jobs.get(child.id).resultFileId!;
    const beforeFiles = c.repository.all('file').length;
    const beforeJobs = c.repository.all('job').length;
    const form = new FormData();
    form.set('file', new File([MODEL], 'rejected.stl'));
    form.set('parentId', id);
    for (const request of [
      requestJson('POST', { fileId: model.id, parentId: id }),
      { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form },
    ]) {
      const response = await c.app.request('/api/slices', request);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'parent_slice_required', parentId: root },
      });
    }
    expect(c.repository.all('file')).toHaveLength(beforeFiles);
    expect(c.repository.all('job')).toHaveLength(beforeJobs);
    for (const parentId of ['', 'not-a-uuid', randomUUID(), model.id]) {
      const response = await c.app.request(
        '/api/slices',
        requestJson('POST', { fileId: model.id, parentId }),
      );
      expect(response.status).toBe(
        parentId === model.id ? 409 : parentId.length === 36 ? 404 : 400,
      );
    }
  });
  it('leaves the root pointer and previews unchanged on storage/CLI failures, then allows a sibling', async () => {
    const { c, model, root, group } = await context();
    const child = await c.jobs.createWithParent(
      model.id,
      SliceOptionsSchema.parse({}),
      undefined,
      root,
    );
    vi.spyOn(c.storage, 'put').mockRejectedValueOnce(new Error('storage failed'));
    await c.jobs.idle();
    expect(c.jobs.get(child.id)).toMatchObject({ state: 'failed', resultFileId: null });
    expect(c.repository.get('plateSet', group.id)?.fileId).toBe(root);
    expect(c.repository.previews(group.id)).toHaveLength(1);
    vi.mocked(c.slicer.slice).mockRejectedValueOnce(new Error('tool failed'));
    const failed = await c.jobs.createWithParent(
      model.id,
      SliceOptionsSchema.parse({}),
      undefined,
      root,
    );
    await c.jobs.idle();
    expect(c.jobs.get(failed.id).state).toBe('failed');
    expect(c.repository.get('plateSet', group.id)?.fileId).toBe(root);
    const retry = await c.jobs.createWithParent(
      model.id,
      SliceOptionsSchema.parse({}),
      undefined,
      root,
    );
    await c.jobs.idle();
    expect(c.jobs.get(retry.id).state).toBe('succeeded');
    expect(c.repository.previews(group.id).map((p) => p.plate)).toEqual([1, 2]);
  });
  it('rolls back group publication if the database transaction fails after storing a result', async () => {
    const { c, model, root, group } = await context();
    const original = c.repository.transaction.bind(c.repository);
    vi.spyOn(c.repository, 'transaction').mockImplementationOnce((fn) =>
      original(() => {
        fn();
        throw new Error('transaction failed');
      }),
    );
    const child = await c.jobs.createWithParent(
      model.id,
      SliceOptionsSchema.parse({}),
      undefined,
      root,
    );
    await c.jobs.idle();
    expect(c.jobs.get(child.id)).toMatchObject({ state: 'failed', resultFileId: null });
    expect(c.repository.get('plateSet', group.id)?.fileId).toBe(root);
    expect(c.repository.previews(group.id)).toHaveLength(1);
    const failed = c.repository.all('file').find((file) => file.parentId === root)!;
    expect(failed.state).toBe('failed');
    expect(await c.storage.head(failed.id)).toBeNull();
  });
  it('recovers a persisted queued append and abandons an interrupted append without changing the parent', async () => {
    const { c, model, root, group } = await context();
    await c.jobs.stop();
    const queuedId = randomUUID(),
      interruptedId = randomUUID();
    const template = {
      modelId: model.id,
      parentId: root,
      options: SliceOptionsSchema.parse({}),
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      resultFileId: null,
      error: null,
    };
    c.repository.insert('job', {
      ...template,
      id: queuedId,
      state: 'queued',
      reservedResultId: randomUUID(),
    });
    c.repository.insert('job', {
      ...template,
      id: interruptedId,
      state: 'running',
      reservedResultId: randomUUID(),
    });
    const recovered = new JobService(c.files, c.slicer, c.converter, c.dir, 1, 20);
    await recovered.recover();
    await recovered.idle();
    expect(recovered.get(interruptedId).error?.code).toBe('interrupted_job');
    expect(recovered.get(queuedId)).toMatchObject({
      state: 'succeeded',
      parentId: root,
      plateId: group.id,
    });
    expect(c.repository.previews(group.id)).toHaveLength(2);
    await recovered.stop();
  });
  it('documents parentId for both input formats and the structured 400 response', async () => {
    const { c } = await context();
    const spec = await (await c.app.request('/openapi.json')).json();
    const route = spec.paths['/api/slices'].post;
    for (const format of ['application/json', 'multipart/form-data'])
      expect(route.requestBody.content[format].schema.properties.parentId).toBeDefined();
    expect(route.description).toContain('error.parentId');
    expect(
      spec.components.schemas.ErrorResponse.properties.error.properties.parentId,
    ).toBeDefined();
  });
});
