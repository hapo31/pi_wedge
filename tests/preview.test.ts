import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { setup, MODEL, GCODE, storedZip, TOKEN } from './helpers.js';
import { SliceOptionsSchema } from '../src/domain/schemas.js';
import { PrintController } from '../web/src/print-controller.js';
import { readLimitedText } from '../web/src/api.js';
import { previewInput } from '../web/src/preview-input.js';
import { PreviewService } from '../src/services/preview.js';
const contexts: Array<Awaited<ReturnType<typeof setup>>> = [];
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
});
async function context() {
  const c = await setup();
  contexts.push(c);
  return c;
}
describe('bounded preview API', () => {
  it('keeps motion/extrusion mode state while excluding startup purge from annotated layers', () => {
    const source = 'M83\nG92 E0\nG1 X0 Y0 Z0.2 E2\n; CHANGE_LAYER\nG1 X80 Y80 Z0.2 E1\n';
    const output = previewInput(source);
    expect(output).toContain('M83\nG92 E0\nG1 X0 Y0 Z0.2 ');
    expect(output).not.toContain('E2');
    expect(output).toContain('G1 X80 Y80 Z0.2 E1');
    expect(previewInput(GCODE)).toBe(GCODE);
  });
  it('extracts generated container toolpaths by UUID and describes the route', async () => {
    const c = await context(),
      model = await c.files.upload(new File([MODEL], 'm.stl')),
      job = c.jobs.create(model.id, SliceOptionsSchema.parse({}));
    await c.jobs.idle();
    const id = c.jobs.get(job.id).resultFileId!;
    const r = await c.app.request(`/api/files/${id}/gcode`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toContain('text/plain');
    expect(await r.text()).toBe(GCODE);
    const spec = await (await c.app.request('/openapi.json')).json();
    expect(spec.paths['/api/files/{uuid}/gcode'].get.responses['413']).toBeDefined();
    expect(spec.paths['/preview/{uuid}'].get.operationId).toBe('openPreview');
    expect(spec.paths['/api/slices'].post.requestBody.required).toBe(true);
  });
  it('rejects model preview, absent file, invalid G-code and oversize extracted entry', async () => {
    const c = await context(),
      f = await c.files.upload(new File([MODEL], 'm.stl')),
      preview = new PreviewService(c.files, c.dir, 10);
    await expect(preview.text(f.id)).rejects.toMatchObject({ status: 409 });
    await expect(preview.text(randomUUID())).rejects.toMatchObject({ status: 404 });
    const id = randomUUID(),
      bytes = storedZip('Metadata/plate_1.gcode', Buffer.from(GCODE));
    const file = { ...f, id, format: 'gcode.3mf' as const, size: bytes.length };
    c.repository.insert('file', file);
    await c.storage.put(id, Readable.from(bytes), bytes.length);
    await expect(preview.text(id)).rejects.toMatchObject({ status: 413 });
    const bad = randomUUID(),
      content = Buffer.from('G1 XNaN Y10 E1\n');
    c.repository.insert('file', { ...file, id: bad, format: 'gcode', size: content.length });
    await c.storage.put(bad, Readable.from(content), content.length);
    await expect(new PreviewService(c.files, c.dir, 1000).text(bad)).rejects.toMatchObject({
      status: 422,
    });
  });
  it('caps streamed browser bytes even without a Content-Length header', async () => {
    const response = new Response('123456');
    await expect(readLimitedText(response, new AbortController().signal, 3)).rejects.toMatchObject({
      status: 413,
    });
  });
});
describe('confirmed print UI controller', () => {
  it('does not send when confirmation is cancelled', async () => {
    const send = vi.fn();
    await new PrintController(send, vi.fn(), () => false).start(randomUUID());
    expect(send).not.toHaveBeenCalled();
  });
  it('blocks double-clicks and keeps one idempotency key after a lost response', async () => {
    let reject: (e: Error) => void = () => {};
    const pending = new Promise<never>((_r, j) => {
        reject = j;
      }),
      send = vi.fn((_fileId: string, _key: string) => pending),
      controller = new PrintController(send, vi.fn(), () => true),
      id = randomUUID();
    const first = controller.start(id);
    await controller.start(id);
    expect(send).toHaveBeenCalledOnce();
    const key = send.mock.calls[0]?.[1];
    reject(new Error('lost response'));
    await first;
    await controller.start(id);
    expect(send.mock.calls[1]?.[1]).toBe(key);
  });
  it('shows accepted and unknown distinctly and never sends again after accepted', async () => {
    const send = vi.fn(async () => ({ id: randomUUID(), state: 'accepted' as const, error: null })),
      update = vi.fn(),
      controller = new PrintController(send, update, () => true);
    await controller.start(randomUUID());
    await controller.start(randomUUID());
    expect(send).toHaveBeenCalledOnce();
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ busy: false, message: expect.stringContaining('受け付け') }),
    );
    const unknownUpdate = vi.fn();
    await new PrintController(
      async () => ({ id: randomUUID(), state: 'unknown', error: null }),
      unknownUpdate,
      () => true,
    ).start(randomUUID());
    expect(unknownUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: expect.stringContaining('結果が不明') }),
    );
  });
});
