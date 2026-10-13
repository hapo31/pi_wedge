import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setup, MODEL } from './helpers.js';
import { SliceOptionsSchema, PrintOptionsSchema } from '../src/domain/schemas.js';
import { validateModel } from '../src/services/files.js';
import { AppError } from '../src/domain/errors.js';
import { Repository } from '../src/adapters/repository.js';
import { FileService } from '../src/services/files.js';
import { PrinterService } from '../src/services/printer.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function context(options: Parameters<typeof setup>[0] = {}) {
  const ctx = await setup(options);
  cleanup.push(ctx.close);
  return ctx;
}
describe('storage and metadata contracts', () => {
  it('uses strict UUID keys, atomically stores streams, verifies size and rejects traversal', async () => {
    const c = await context(),
      id = randomUUID();
    await c.storage.put(id, Readable.from('hello'), 5);
    expect(await c.storage.head(id)).toEqual({ size: 5 });
    expect(
      await new Response(Readable.toWeb(await c.storage.get(id)) as ReadableStream).text(),
    ).toBe('hello');
    await c.storage.delete(id);
    expect(await c.storage.head(id)).toBeNull();
    await expect(c.storage.put('../escape', Readable.from('x'), 1)).rejects.toThrow();
    await expect(c.storage.put(id, Readable.from('wrong'), 1)).rejects.toThrow();
    expect((await readdir(join(c.dir, 'objects'))).length).toBe(0);
  });
  it('creates unique model UUIDs and survives database restart', async () => {
    const c = await context();
    const a = await c.files.upload(new File([MODEL], 'a.stl')),
      b = await c.files.upload(new File([MODEL], 'b.stl'));
    expect(a.id).not.toBe(b.id);
    expect(a.state).toBe('ready');
    const second = new Repository(join(c.dir, 'metadata.sqlite'));
    expect(second.get('file', a.id)?.name).toBe('a.stl');
    second.close();
  });
  it('marks storage failure and never exposes a ready file', async () => {
    const c = await context();
    vi.spyOn(c.storage, 'put').mockRejectedValue(new Error('private provider error'));
    await expect(c.files.upload(new File([MODEL], 'a.stl'))).rejects.toMatchObject({
      code: 'storage_unavailable',
    });
    expect(c.repository.all('file')[0]?.state).toBe('failed');
  });
  it('repairs staged atomic writes and marks absent staged objects failed', async () => {
    const c = await context();
    const a = await c.files.upload(new File([MODEL], 'a.stl'));
    a.state = 'staging';
    c.repository.save('file', a);
    const b = { ...a, id: randomUUID() };
    c.repository.insert('file', b);
    await c.files.recover();
    expect(c.files.metadata(a.id).state).toBe('ready');
    expect(c.files.metadata(b.id).state).toBe('failed');
  });
  it('detects loss of a ready object', async () => {
    const c = await context(),
      f = await c.files.upload(new File([MODEL], 'a.stl'));
    await c.storage.delete(f.id);
    await expect(c.files.download(f.id)).rejects.toMatchObject({ status: 503 });
  });
  it('checks STL/STEP contents, formats, finite coordinates, sizes and settings', async () => {
    expect(validateModel('a.stl', Buffer.from(MODEL))).toBe('stl');
    expect(
      validateModel('a.STP', Buffer.from('ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;')),
    ).toBe('step');
    expect(() => validateModel('a.stl', Buffer.from('malicious'))).toThrow();
    expect(() => validateModel('a.stl', Buffer.from(MODEL.replace('10 0 0', 'NaN 0 0')))).toThrow();
    expect(() => validateModel('a.txt', Buffer.from(MODEL))).toThrow();
    expect(() =>
      SliceOptionsSchema.parse({ settings: { machine_start_gcode: 'unsafe' } }),
    ).toThrow();
    const c = await context();
    await expect(
      c.files.upload(new File([new Uint8Array(1048577)], 'a.stl')),
    ).rejects.toMatchObject({ status: 413 });
  });
});
describe('persistent asynchronous jobs and swappable slicer', () => {
  it('runs STL through the Slicer interface and saves a UUID result without printing', async () => {
    const c = await context(),
      f = await c.files.upload(new File([MODEL], 'a.stl'));
    const job = c.jobs.create(f.id, SliceOptionsSchema.parse({}));
    expect(job.state).toBe('queued');
    await c.jobs.idle();
    const done = c.jobs.get(job.id);
    expect(done.state).toBe('succeeded');
    expect(c.files.metadata(done.resultFileId!).sourceModelId).toBe(f.id);
    expect(c.repository.get('file', done.resultFileId!)).not.toHaveProperty('path');
    expect(c.adapter.startPrint).not.toHaveBeenCalled();
    expect(await readdir(join(c.dir, 'tmp'))).toEqual([]);
  });
  it('converts STEP through a separate component before the slicer', async () => {
    const c = await context(),
      f = await c.files.upload(new File(['ISO-10303-21;\nEND-ISO-10303-21;'], 'a.step'));
    c.jobs.create(f.id, SliceOptionsSchema.parse({ mesh: { linearDeflection: 0.2 } }));
    await c.jobs.idle();
    expect(c.converter.convert).toHaveBeenCalledOnce();
    expect(c.slicer.slice).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'stl' }),
      expect.objectContaining({ mesh: { linearDeflection: 0.2, angularDeflection: 0.5 } }),
    );
  });
  it('persists failures and cleans work directories', async () => {
    const c = await context({
        slicer: {
          slice: vi
            .fn()
            .mockRejectedValue(
              new AppError('command_timeout', 'External tool exceeded its time limit', 503),
            ),
        },
      }),
      f = await c.files.upload(new File([MODEL], 'a.stl'));
    const job = c.jobs.create(f.id, SliceOptionsSchema.parse({}));
    await c.jobs.idle();
    expect(c.jobs.get(job.id)).toMatchObject({
      state: 'failed',
      resultFileId: null,
      error: { code: 'command_timeout' },
    });
    expect(await readdir(join(c.dir, 'tmp'))).toEqual([]);
  });
  it('limits concurrency and queued jobs', async () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((r) => {
      release = r;
    });
    let active = 0,
      max = 0;
    const c = await context({
      maxQueued: 1,
      slicer: {
        slice: async () => {
          max = Math.max(max, ++active);
          await wait;
          active--;
          throw new Error('fixture');
        },
      },
    });
    const f = await c.files.upload(new File([MODEL], 'a.stl'));
    c.jobs.create(f.id, SliceOptionsSchema.parse({}));
    await new Promise((r) => setTimeout(r, 10));
    c.jobs.create(f.id, SliceOptionsSchema.parse({}));
    expect(() => c.jobs.create(f.id, SliceOptionsSchema.parse({}))).toThrow('queue is full');
    release();
    await c.jobs.idle();
    expect(max).toBe(1);
  });
  it('fails interrupted running jobs and discards their unfinished result', async () => {
    const c = await context(),
      f = await c.files.upload(new File([MODEL], 'a.stl')),
      id = randomUUID(),
      result = randomUUID();
    c.repository.insert('job', {
      id,
      modelId: f.id,
      options: SliceOptionsSchema.parse({}),
      state: 'running',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      resultFileId: null,
      error: null,
      reservedResultId: result,
    });
    await c.storage.put(result, Readable.from('partial'), 7);
    await c.jobs.recover();
    expect(c.jobs.get(id).error?.code).toBe('interrupted_job');
    expect(await c.storage.head(result)).toBeNull();
  });
});
describe('printer orchestration and persistent idempotency', () => {
  async function artifact(c: Awaited<ReturnType<typeof context>>) {
    const f = await c.files.upload(new File([MODEL], 'a.stl')),
      job = c.jobs.create(f.id, SliceOptionsSchema.parse({}));
    await c.jobs.idle();
    return c.jobs.get(job.id).resultFileId!;
  }
  it('separates upload/print and accepts each operation key once across instances', async () => {
    const c = await context(),
      id = await artifact(c),
      key = randomUUID(),
      options = PrintOptionsSchema.parse({});
    await c.printer.upload(id);
    expect(c.adapter.startPrint).not.toHaveBeenCalled();
    expect((await c.printer.print(id, options, key)).state).toBe('accepted');
    expect((await c.printer.print(id, options, key)).state).toBe('accepted');
    expect(c.adapter.startPrint).toHaveBeenCalledOnce();
    await expect(
      c.printer.print(id, { ...options, bedLeveling: false }, key),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('records unknown without resending and blocks new keys until inspected', async () => {
    const c = await context({
        printer: {
          upload: vi.fn(async () => ({ remotePath: '/file' })),
          startPrint: vi
            .fn()
            .mockRejectedValue(new AppError('printer_outcome_unknown', 'Unknown dispatch', 504)),
          stopPrint: vi.fn(async () => {}),
        },
      }),
      id = await artifact(c),
      key = randomUUID(),
      options = PrintOptionsSchema.parse({});
    expect((await c.printer.print(id, options, key)).state).toBe('unknown');
    await c.printer.print(id, options, key);
    expect(c.adapter.startPrint).toHaveBeenCalledOnce();
    await expect(c.printer.print(id, options, randomUUID())).rejects.toMatchObject({ status: 409 });
  });
  it('converts pending operations to unknown after restart', async () => {
    const c = await context(),
      key = randomUUID();
    c.repository.insert('operation', {
      id: key,
      fileId: randomUUID(),
      options: PrintOptionsSchema.parse({}),
      state: 'pending',
      createdAt: new Date().toISOString(),
      error: null,
    });
    await c.printer.recover();
    expect(c.printer.get(key).state).toBe('unknown');
  });
  it('persists stop idempotency across reopened SQLite and forbids sharing keys with start', async () => {
    const c = await context(),
      key = randomUUID();
    expect((await c.printer.stopPrint(key)).state).toBe('accepted');
    expect(c.adapter.upload).not.toHaveBeenCalled();
    expect(c.adapter.startPrint).not.toHaveBeenCalled();
    const repository = new Repository(join(c.dir, 'metadata.sqlite'));
    try {
      const service = new PrinterService(
        new FileService(repository, c.storage, 1048576, 10485760),
        c.adapter,
        c.dir,
      );
      expect((await service.stopPrint(key)).state).toBe('accepted');
      expect(c.adapter.stopPrint).toHaveBeenCalledOnce();
      await expect(
        service.print(randomUUID(), PrintOptionsSchema.parse({}), key),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      const startKey = randomUUID();
      repository.insert('operation', {
        id: startKey,
        fileId: randomUUID(),
        options: PrintOptionsSchema.parse({}),
        state: 'accepted',
        createdAt: new Date().toISOString(),
        error: null,
      });
      await expect(service.stopPrint(startKey)).rejects.toMatchObject({
        code: 'idempotency_conflict',
      });
    } finally {
      repository.close();
    }
  });
  it('permits stop despite an unresolved start, but preserves that start outcome', async () => {
    const c = await context(),
      startKey = randomUUID();
    c.repository.insert('operation', {
      id: startKey,
      fileId: randomUUID(),
      options: PrintOptionsSchema.parse({}),
      state: 'unknown',
      createdAt: new Date().toISOString(),
      error: null,
    });
    expect((await c.printer.stopPrint(randomUUID())).state).toBe('accepted');
    expect(c.printer.get(startKey).state).toBe('unknown');
  });
  it('does not resend unknown stops and blocks fresh stop/start keys until resolution', async () => {
    const c = await context(),
      id = await artifact(c),
      key = randomUUID();
    vi.mocked(c.adapter.stopPrint).mockRejectedValue(
      new AppError('printer_outcome_unknown', 'Lost stop ACK', 504),
    );
    expect((await c.printer.stopPrint(key)).state).toBe('unknown');
    await c.printer.stopPrint(key);
    expect(c.adapter.stopPrint).toHaveBeenCalledOnce();
    await expect(c.printer.stopPrint(randomUUID())).rejects.toMatchObject({ status: 409 });
    await expect(
      c.printer.print(id, PrintOptionsSchema.parse({}), randomUUID()),
    ).rejects.toMatchObject({ status: 409 });
    c.printer.resolveUnknown(key, 'accepted', 'Inspected printer: stopped.');
    expect((await c.printer.print(id, PrintOptionsSchema.parse({}), randomUUID())).state).toBe(
      'accepted',
    );
    expect(c.printer.get(key)).toMatchObject({ action: 'stop', state: 'accepted' });
  });
  it('returns pending for the same in-flight stop, rejects concurrent commands and recovers pending stops', async () => {
    const c = await context(),
      key = randomUUID();
    let release!: () => void;
    vi.mocked(c.adapter.stopPrint).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stopping = c.printer.stopPrint(key);
    expect((await c.printer.stopPrint(key)).state).toBe('pending');
    await expect(c.printer.stopPrint(randomUUID())).rejects.toMatchObject({ code: 'printer_busy' });
    release();
    await stopping;
    const pendingKey = randomUUID();
    c.repository.insert('stopOperation', {
      id: pendingKey,
      action: 'stop',
      state: 'pending',
      createdAt: new Date().toISOString(),
      error: null,
    });
    await c.printer.recover();
    expect(c.printer.get(pendingKey)).toMatchObject({ action: 'stop', state: 'unknown' });
    await c.printer.stopPrint(pendingKey);
    expect(c.adapter.stopPrint).toHaveBeenCalledOnce();
  });
});
