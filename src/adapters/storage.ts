import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ObjectStorage } from '../domain/contracts.js';
import type { Config } from '../config.js';
import { Uuid } from '../domain/schemas.js';
import { AppError } from '../domain/errors.js';
export class LocalStorage implements ObjectStorage {
  private active = new Set<string>();
  constructor(private dir: string) {}
  private path(id: string) {
    return join(this.dir, Uuid.parse(id));
  }
  async put(id: string, body: Readable, size: number) {
    const target = this.path(id),
      temp = `${target}.${randomUUID()}.tmp`;
    this.active.add(temp);
    let bytes = 0;
    try {
      await mkdir(this.dir, { recursive: true });
      await pipeline(
        body,
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            bytes += chunk.length;
            cb(
              bytes > size
                ? new AppError('storage_size_mismatch', 'Object size mismatch', 503)
                : null,
              chunk,
            );
          },
        }),
        createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
      );
      if (bytes !== size) throw new AppError('storage_size_mismatch', 'Object size mismatch', 503);
      await rename(temp, target);
    } finally {
      try {
        await rm(temp, { force: true });
      } finally {
        this.active.delete(temp);
      }
    }
  }
  async recover() {
    await mkdir(this.dir, { recursive: true });
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
    const temporary = new RegExp(`^${uuid}\\.${uuid}\\.tmp$`, 'i');
    for (const entry of await readdir(this.dir, { withFileTypes: true })) {
      const path = join(this.dir, entry.name);
      if (entry.isFile() && temporary.test(entry.name) && !this.active.has(path))
        await rm(path, { force: true });
    }
  }
  async get(id: string) {
    if (!(await this.head(id)))
      throw new AppError('object_missing', 'Stored object is unavailable', 503);
    return createReadStream(this.path(id));
  }
  async head(id: string) {
    try {
      return { size: (await stat(this.path(id))).size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async delete(id: string) {
    await rm(this.path(id), { force: true });
  }
  async check() {
    await mkdir(this.dir, { recursive: true });
    await stat(this.dir);
  }
}
export class S3Storage implements ObjectStorage {
  private client: S3Client;
  private bucket: string;
  constructor(c: Config) {
    this.bucket = c.S3_BUCKET;
    this.client = new S3Client({
      endpoint: c.S3_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: c.S3_ACCESS_KEY, secretAccessKey: c.S3_SECRET_KEY },
      requestHandler: { connectionTimeout: 5000, requestTimeout: 60000 },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  private params(id: string) {
    return { Bucket: this.bucket, Key: Uuid.parse(id) };
  }
  async put(id: string, body: Readable, size: number) {
    await this.client.send(
      new PutObjectCommand({ ...this.params(id), Body: body, ContentLength: size }),
      { abortSignal: AbortSignal.timeout(60000) },
    );
  }
  async get(id: string) {
    const r = await this.client.send(new GetObjectCommand(this.params(id)), {
      abortSignal: AbortSignal.timeout(60000),
    });
    if (!(r.Body instanceof Readable))
      throw new AppError('object_missing', 'Stored object is unavailable', 503);
    return r.Body;
  }
  async head(id: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand(this.params(id)), {
        abortSignal: AbortSignal.timeout(10000),
      });
      return { size: r.ContentLength ?? 0 };
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404)
        return null;
      throw error;
    }
  }
  async delete(id: string) {
    await this.client.send(new DeleteObjectCommand(this.params(id)), {
      abortSignal: AbortSignal.timeout(10000),
    });
  }
  async check() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
      abortSignal: AbortSignal.timeout(5000),
    });
  }
  close() {
    this.client.destroy();
  }
}
