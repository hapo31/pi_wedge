import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { Repository } from '../src/adapters/repository.js';
import { LocalStorage } from '../src/adapters/storage.js';
import { FileService } from '../src/services/files.js';
import { JobService } from '../src/services/jobs.js';
import { PrinterService } from '../src/services/printer.js';
import { listPlates, openGcode } from '../src/adapters/gcode.js';
import { createApp } from '../src/app.js';
import type { Slicer, ModelConverter, Printer } from '../src/domain/contracts.js';
export const TOKEN = 'test-only-token-01234567890123456789';
export const MODEL =
  'solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid triangle\n';
export const GCODE =
  '; estimated printing time (normal mode) = 1m 2s\n; filament used [g] = 1.2\n; filament used [mm] = 340\nG21\nG90\nM83\nG1 Z0.2\nG1 X10 Y10 F1200\nG1 X20 Y10 E1\nG1 X20 Y20 E1\nG1 Z0.4\nG1 X10 Y20 E1\n';
export function storedZip(name: string, body: Buffer) {
  return storedEntries([[name, body]]);
}
export function storedEntries(entries: [string, Buffer][]) {
  const files: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of entries) {
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const n = Buffer.from(name),
      header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    files.push(header, n, body);
    directory.push(central, n);
    offset += header.length + n.length + body.length;
  }
  const central = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, central, end]);
}
export async function setup(
  overrides: {
    slicer?: Slicer;
    converter?: ModelConverter;
    printer?: Printer;
    maxQueued?: number;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-wedge-test-'));
  const config = readConfig({
    API_TOKEN: TOKEN,
    DATA_DIR: dir,
    STORAGE_BACKEND: 'local',
    MAX_UPLOAD_MB: '1',
  });
  const repository = new Repository(join(dir, 'metadata.sqlite')),
    storage = new LocalStorage(join(dir, 'objects'));
  const files = new FileService(repository, storage, 1048576, 10485760);
  const slicer: Slicer = overrides.slicer ?? {
    slice: vi.fn(async (input, _options, parent) => {
      const path = join(input.workDir, 'result.gcode.3mf');
      const entries: [string, Buffer][] = [];
      if (parent)
        for (const plate of await listPlates(parent.path)) {
          const chunks: Buffer[] = [];
          for await (const chunk of await openGcode(parent.path, 'gcode.3mf', 10485760, plate))
            chunks.push(Buffer.from(chunk));
          entries.push([`Metadata/plate_${plate}.gcode`, Buffer.concat(chunks)]);
        }
      entries.push([`Metadata/plate_${parent?.plate ?? 1}.gcode`, Buffer.from(GCODE)]);
      await writeFile(path, storedEntries(entries));
      return {
        path,
        format: 'gcode.3mf' as const,
        ...(parent ? { plate: parent.plate } : {}),
        estimatedSeconds: 62,
        filamentGrams: 1.2,
        filamentMillimeters: 340,
      };
    }),
  };
  const converter: ModelConverter = overrides.converter ?? {
    convert: vi.fn(async (input) => ({ ...input, format: 'stl' })),
  };
  const adapter: Printer = overrides.printer ?? {
    upload: vi.fn(async (file) => ({ remotePath: `/${file.id}.gcode.3mf` })),
    readStatus: vi.fn(async () => ({
      observedAt: new Date().toISOString(),
      gcodeState: 'IDLE',
      amsConnected: false,
      currentSlot: null,
      externalSpoolActive: false,
      slots: [],
    })),
    startPrint: vi.fn(async () => {}),
    stopPrint: vi.fn(async () => {}),
  };
  const jobs = new JobService(files, slicer, converter, dir, 1, overrides.maxQueued ?? 20),
    printer = new PrinterService(files, adapter, dir);
  const app = createApp({ files, jobs, printer, config });
  return {
    dir,
    config,
    repository,
    storage,
    files,
    jobs,
    printer,
    adapter,
    slicer,
    converter,
    app,
    async close() {
      await jobs.stop();
      repository.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
export function requestJson(method: string, body: unknown, key?: string): RequestInit {
  return {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  };
}
