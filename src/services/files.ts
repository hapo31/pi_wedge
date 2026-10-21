import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename } from 'node:path';
import type { ObjectStorage } from '../domain/contracts.js';
import type { FileMetadata, SliceOptions } from '../domain/schemas.js';
import { Uuid, FileSchema } from '../domain/schemas.js';
import { AppError, safeError, logError } from '../domain/errors.js';
import { Repository } from '../adapters/repository.js';
export function validateModel(name: string, bytes: Buffer): 'stl' | 'step' {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'step' || ext === 'stp') {
    const head = bytes.subarray(0, 1024).toString('ascii'),
      tail = bytes.subarray(-1024).toString('ascii');
    if (!head.includes('ISO-10303-21;') || !tail.includes('END-ISO-10303-21;'))
      throw new AppError('invalid_file', 'Invalid STEP exchange file', 400);
    return 'step';
  }
  if (ext !== 'stl')
    throw new AppError('unsupported_format', 'Only STL and STEP model uploads are supported', 415);
  if (bytes.length >= 84) {
    const count = bytes.readUInt32LE(80);
    if (count > 0 && bytes.length === 84 + count * 50) {
      if (count > 1000000) throw new AppError('invalid_file', 'STL triangle limit exceeded', 400);
      for (let i = 0; i < count; i++)
        for (let j = 0; j < 12; j++)
          if (!Number.isFinite(bytes.readFloatLE(84 + i * 50 + j * 4)))
            throw new AppError('invalid_file', 'Non-finite STL coordinates', 400);
      return 'stl';
    }
  }
  const text = bytes.toString('ascii');
  const vertices = [...text.matchAll(/\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g)];
  const facets = (text.match(/\bendfacet\b/g) ?? []).length;
  if (
    !/^\s*solid\b/i.test(text) ||
    !text.includes('endsolid') ||
    !facets ||
    vertices.length !== facets * 3 ||
    facets > 1000000 ||
    vertices.some((m) => m.slice(1).some((v) => !Number.isFinite(Number(v))))
  )
    throw new AppError('invalid_file', 'Invalid ASCII or binary STL', 400);
  return 'stl';
}
export class FileService {
  constructor(
    public readonly repository: Repository,
    public readonly storage: ObjectStorage,
    private maxUpload: number,
    private maxArtifact: number,
  ) {}
  metadata(id: string) {
    const file = this.repository.get('file', Uuid.parse(id));
    if (!file) throw new AppError('file_not_found', 'File UUID does not exist', 404);
    return FileSchema.parse(file);
  }
  ready(id: string) {
    const f = this.metadata(id);
    if (f.state !== 'ready') throw new AppError('file_not_ready', 'File is not ready', 409);
    return f;
  }
  async upload(file: File) {
    if (file.size === 0) throw new AppError('invalid_file', 'Empty upload', 400);
    if (file.size > this.maxUpload)
      throw new AppError('too_large', 'Upload size limit exceeded', 413);
    const bytes = Buffer.from(await file.arrayBuffer());
    const format = validateModel(file.name, bytes);
    const name =
      basename(file.name.replaceAll('\\', '/'))
        .split('')
        .filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127)
        .join('')
        .slice(0, 255) || `model.${format}`;
    return this.persist(
      {
        id: randomUUID(),
        name,
        format,
        size: bytes.length,
        sourceModelId: null,
        sliceOptions: null,
        estimatedSeconds: null,
        filamentGrams: null,
        filamentMillimeters: null,
      },
      Readable.from(bytes),
    );
  }
  async saveResult(
    id: string,
    path: string,
    sourceModelId: string,
    options: SliceOptions,
    stats: Pick<FileMetadata, 'estimatedSeconds' | 'filamentGrams' | 'filamentMillimeters'>,
    format: 'gcode' | 'gcode.3mf',
    displayName?: string,
    parentId?: string,
    plate?: number,
  ) {
    const size = (await stat(path)).size;
    if (!size || size > this.maxArtifact)
      throw new AppError('too_large', 'Slice artifact size limit exceeded', 413);
    return this.persist(
      {
        id,
        name: `${id}.${format}`,
        displayName,
        parentId,
        plate,
        format,
        size,
        sourceModelId,
        sliceOptions: options,
        estimatedSeconds: stats.estimatedSeconds,
        filamentGrams: stats.filamentGrams,
        filamentMillimeters: stats.filamentMillimeters,
      },
      createReadStream(path),
    );
  }
  private async persist(
    fields: Omit<FileMetadata, 'createdAt' | 'state' | 'error'>,
    body: Readable,
  ) {
    const record: FileMetadata = {
      ...fields,
      createdAt: new Date().toISOString(),
      state: 'staging',
      error: null,
    };
    this.repository.insert('file', record);
    try {
      await this.storage.put(record.id, body, record.size);
      record.state = 'ready';
      this.repository.save('file', record);
      return record;
    } catch (error) {
      body.destroy();
      record.state = 'failed';
      record.error = safeError(error);
      this.repository.save('file', record);
      await this.storage.delete(record.id).catch((e) => logError('storage_cleanup', record.id, e));
      logError('file_write', record.id, error);
      throw new AppError('storage_unavailable', 'File storage failed', 503);
    }
  }
  async download(id: string) {
    const file = this.ready(id);
    try {
      const head = await this.storage.head(id);
      if (!head || head.size !== file.size) throw new Error('missing');
      return { file, stream: await this.storage.get(id) };
    } catch (error) {
      logError('file_read', id, error);
      throw new AppError('storage_unavailable', 'Stored file is missing or unavailable', 503);
    }
  }
  async materialize(id: string, path: string) {
    const { file, stream } = await this.download(id);
    let bytes = 0;
    await pipeline(
      stream,
      new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          cb(
            bytes > file.size
              ? new AppError('storage_size_mismatch', 'Stored file size mismatch', 503)
              : null,
            chunk,
          );
        },
      }),
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
    );
    if (bytes !== file.size)
      throw new AppError('storage_size_mismatch', 'Stored file size mismatch', 503);
  }
  async recover() {
    for (const file of this.repository.all('file').filter((f) => f.state === 'staging')) {
      const head = await this.storage.head(file.id);
      if (head?.size === file.size) {
        file.state = 'ready';
        file.error = null;
      } else {
        await this.storage.delete(file.id);
        file.state = 'failed';
        file.error = {
          code: 'interrupted_write',
          message: 'Incomplete storage write during restart',
        };
      }
      this.repository.save('file', file);
    }
  }
  async abandon(id: string) {
    const f = this.repository.get('file', id);
    if (f) {
      f.state = 'failed';
      f.error = {
        code: 'interrupted_job',
        message: 'Result was interrupted before job completion',
      };
      this.repository.save('file', f);
    }
    await this.storage.delete(id);
  }
}
