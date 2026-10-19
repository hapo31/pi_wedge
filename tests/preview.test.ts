import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  PerspectiveCamera,
  Scene,
  Vector3,
} from 'three';
import { setup, MODEL, GCODE, storedZip, TOKEN } from './helpers.js';
import { SliceOptionsSchema } from '../src/domain/schemas.js';
import { PrintController } from '../web/src/print-controller.js';
import { readLimitedText } from '../web/src/api.js';
import { previewInput } from '../web/src/preview-input.js';
import { fitToolpath, gcodeBatches } from '../web/src/toolpath.js';
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
  it('frames every corner of a tall model in desktop and narrow viewports', () => {
    const scene = new Scene();
    const group = new Group();
    group.name = 'layer1';
    const corners: Vector3[] = [];
    for (const x of [-80, 80])
      for (const y of [0, 108]) for (const z of [-80, 80]) corners.push(new Vector3(x, y, z));
    const geometry = new BufferGeometry().setFromPoints(corners);
    const material = new LineBasicMaterial();
    group.add(new LineSegments(geometry, material));
    scene.add(group);
    for (const aspect of [1.5, 0.84, 0.5]) {
      const camera = new PerspectiveCamera(45, aspect, 0.1, 10000);
      camera.position.set(250, 220, 250);
      const controls = {
        target: new Vector3(),
        update: () => {
          camera.lookAt(controls.target);
          camera.updateMatrixWorld();
          return true;
        },
      };
      fitToolpath({ scene, camera, controls });
      expect(controls.target.toArray()).toEqual([0, 54, 0]);
      for (const corner of corners) {
        const point = corner.clone().project(camera);
        expect(Math.abs(point.x)).toBeLessThan(1);
        expect(Math.abs(point.y)).toBeLessThan(1);
        expect(point.z).toBeGreaterThan(-1);
        expect(point.z).toBeLessThan(1);
      }
    }
    geometry.dispose();
    material.dispose();
  });
  it('returns the complete toolpath above the former line limits for raw and container files', async () => {
    const c = await context();
    const model = await c.files.upload(new File([MODEL], 'm.stl'));
    const text = GCODE + ';\n'.repeat(2000001) + 'G1 X25 Y25 E1';
    for (const format of ['gcode', 'gcode.3mf'] as const) {
      const id = randomUUID();
      const bytes =
        format === 'gcode'
          ? Buffer.from(text)
          : storedZip('Metadata/plate_1.gcode', Buffer.from(text));
      c.repository.insert('file', { ...model, id, format, size: bytes.length });
      await c.storage.put(id, Readable.from(bytes), bytes.length);
      for (const path of [`/preview/${id}/gcode`, `/api/files/${id}/gcode`]) {
        const response = await c.app.request(path, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(text);
      }
    }
    expect(c.adapter.startPrint).not.toHaveBeenCalled();
  });
  it('scans more than 250,000 lines in bounded batches without losing the final command', () => {
    const text = 'G1 X10 Y20 E1\n'.repeat(250001) + 'G1 X30 Y40 E1';
    let reconstructed = '';
    for (const { lines, offset } of gcodeBatches(text)) {
      expect(lines.length).toBeLessThanOrEqual(1000);
      reconstructed += lines.join('\n') + (offset < text.length ? '\n' : '');
    }
    expect(reconstructed).toBe(text);
    expect([...gcodeBatches('G1 X1\r\nG1 X2\n')].flatMap((batch) => batch.lines)).toEqual([
      'G1 X1\r',
      'G1 X2',
    ]);
  });
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
    for (const path of ['/api/files/{uuid}/gcode', '/preview/{uuid}/gcode']) {
      expect(spec.paths[path].get.description).toContain('no total line-count limit');
      expect(spec.paths[path].get.description).toContain('32 MiB after decompression');
    }
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
  it('shows the transfer failure cause without exposing the adapter message', async () => {
    const update = vi.fn();
    await new PrintController(
      async () => ({
        id: randomUUID(),
        state: 'failed',
        error: {
          code: 'printer_upload_failed',
          message: 'FTPS upload or remote size verification failed',
        },
      }),
      update,
      () => true,
    ).start(randomUUID());
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        busy: false,
        message: 'ファイルを転送できませんでした。プリンターの接続を確認してください。',
      }),
    );
  });
});
