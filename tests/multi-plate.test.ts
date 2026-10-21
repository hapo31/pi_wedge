import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, MODEL, GCODE, storedEntries, TOKEN } from './helpers.js';
import { Repository } from '../src/adapters/repository.js';
import { listPlates } from '../src/adapters/gcode.js';
import { PreviewService } from '../src/services/preview.js';
import * as thumbnails from '../src/services/thumbnail.js';
const contexts: Awaited<ReturnType<typeof setup>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of contexts.splice(0)) await c.close();
});
async function context() {
  const c = await setup();
  contexts.push(c);
  const model = await c.files.upload(new File([MODEL], 'plates.stl'));
  const id = randomUUID();
  const second = GCODE.replace('1m 2s', '5m').replace('= 1.2', '= 4.5').replaceAll('X20', 'X40');
  const bytes = storedEntries([
    ['Metadata/plate_3.gcode', Buffer.from(second)],
    ['Metadata/plate_1.gcode', Buffer.from(GCODE)],
  ]);
  c.repository.insert('file', {
    ...model,
    id,
    format: 'gcode.3mf',
    sourceModelId: model.id,
    size: bytes.length,
  });
  await c.storage.put(id, Readable.from(bytes), bytes.length);
  return { c, id, second };
}
describe('persistent multi-plate previews', () => {
  it('holds the processing budget through thumbnail generation and releases it after cancellation', async () => {
    const { c, id } = await context();
    const service = new PreviewService(c.files, c.dir, 32 * 1048576);
    const { group } = await service.selection(id);
    const generate = thumbnails.toolpathThumbnail;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const generator = vi
      .spyOn(thumbnails, 'toolpathThumbnail')
      .mockImplementation(async (...args) => {
        await gate;
        return generate(...args);
      });
    const abort = new AbortController();
    const first = service.thumbnail(group.id, id, abort.signal);
    const second = service.thumbnail(group.id, id);
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    try {
      await vi.waitFor(() => expect(generator).toHaveBeenCalledTimes(2));
      await expect(service.details(group.id, id)).rejects.toMatchObject({ code: 'preview_busy' });
      abort.abort();
    } finally {
      release();
    }
    await cancelled;
    expect(await second).toContain('<svg');
    expect(await service.selectedText(group.id, id)).toBe(GCODE);
    expect(await readdir(join(c.dir, 'preview-tmp'))).toEqual([]);
  });

  it('redirects legacy/group URLs, persists both UUIDs and exposes only preview metadata', async () => {
    const { c, id } = await context();
    const data = await (await c.app.request(`/preview/${id}/data`)).json();
    expect(data).toMatchObject({
      previewId: id,
      plate: 1,
      plates: [{ id, plate: 1 }, { plate: 3 }],
    });
    expect(data.plateId).not.toBe(id);
    expect(data.file).not.toHaveProperty('sliceOptions');
    expect(data.file).not.toHaveProperty('sourceModelId');
    for (const target of [id, data.plateId]) {
      const response = await c.app.request(`/preview/${target}`);
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe(`/preview/${data.plateId}/${id}`);
    }
    const other = new Repository(join(c.dir, 'metadata.sqlite'));
    expect(other.previews(data.plateId).map((p) => p.id)).toEqual(
      data.plates.map((p: { id: string }) => p.id),
    );
    other.close();
    const history = await (await c.app.request('/history/data')).json();
    expect(history.items[0]).toMatchObject({
      id,
      plateId: data.plateId,
      previewId: id,
      plateCount: 2,
    });
    expect(c.adapter.startPrint).not.toHaveBeenCalled();
  });
  it('selects nonconsecutive plate IDs, thumbnails and stats while rejecting foreign previews', async () => {
    const { c, id, second } = await context();
    const data = await (await c.app.request(`/preview/${id}/data`)).json();
    const next = data.plates[1].id;
    const selected = await (
      await c.app.request(`/preview/${data.plateId}/data?previewId=${next}`)
    ).json();
    expect(selected).toMatchObject({
      plate: 3,
      previewId: next,
      file: { estimatedSeconds: 300, filamentGrams: 4.5 },
    });
    const gcode = await c.app.request(`/preview/${data.plateId}/gcode?previewId=${next}`);
    expect(await gcode.text()).toBe(second);
    const api = await c.app.request(`/api/files/${id}/gcode?plate=3`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(await api.text()).toBe(second);
    const image = await c.app.request(`/preview/${data.plateId}/thumbnail?previewId=${next}`);
    expect(image.headers.get('Content-Type')).toContain('image/svg+xml');
    expect(await image.text()).toMatch(/<path d="M[\d.]+/);
    for (const action of ['data', 'gcode', 'thumbnail']) {
      expect(
        (await c.app.request(`/preview/${data.plateId}/${action}?previewId=${randomUUID()}`))
          .status,
      ).toBe(404);
      expect((await c.app.request(`/preview/${data.plateId}/${action}?previewId=bad`)).status).toBe(
        400,
      );
      expect(
        (await c.app.request(`/preview/${data.plateId}/${action}?path=elsewhere`)).status,
      ).toBe(400);
    }
    expect(await readdir(join(c.dir, 'preview-tmp'))).toEqual([]);
  });
  it('prints the selected source plate and never reuses a key for another plate', async () => {
    const { c, id } = await context();
    c.config.PRINTER_ENABLED = true;
    const data = await (await c.app.request(`/preview/${id}/data`)).json();
    const key = randomUUID();
    const request = {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Idempotency-Key': key },
    };
    const url = `/preview/${data.plateId}/print?previewId=${data.plates[1].id}`;
    expect((await c.app.request(url, request)).status).toBe(200);
    expect((await c.app.request(url, request)).status).toBe(200);
    expect(c.adapter.startPrint).toHaveBeenCalledOnce();
    expect(c.adapter.startPrint).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ plate: 3 }),
      key,
    );
    expect(
      (await c.app.request(`/preview/${data.plateId}/print?previewId=${id}`, request)).status,
    ).toBe(409);
  });
  it('rejects duplicate entries and archives above the plate/entry limits', async () => {
    const { c } = await context();
    const path = join(c.dir, 'invalid.3mf');
    for (const entries of [
      [
        ['Metadata/plate_1.gcode', Buffer.from(GCODE)],
        ['Metadata/plate_1.gcode', Buffer.from(GCODE)],
      ],
      [['Metadata/plate_101.gcode', Buffer.from(GCODE)]],
      Array.from({ length: 2001 }, (_, i) => [`file${i}`, Buffer.from('x')]),
    ] as [string, Buffer][][]) {
      await writeFile(path, storedEntries(entries));
      await expect(listPlates(path)).rejects.toMatchObject({ status: 422 });
    }
  });
});
