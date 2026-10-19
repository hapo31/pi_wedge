import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { openGcode, inspectGcode } from '../adapters/gcode.js';
import { AppError, logError } from '../domain/errors.js';
import { FileService } from './files.js';
import { Uuid } from '../domain/schemas.js';
export class PreviewService {
  private active = 0;
  constructor(
    private files: FileService,
    private dataDir: string,
    private maxBytes: number,
  ) {}
  file(id: string) {
    const file = this.files.ready(id);
    if (file.format !== 'gcode' && file.format !== 'gcode.3mf')
      throw new AppError('wrong_kind', 'Preview requires a G-code slice result UUID', 409);
    return { ...file, format: file.format };
  }
  details(id: string) {
    const file = this.file(id);
    return {
      file,
      displayName:
        file.displayName ??
        (file.sourceModelId ? this.files.metadata(file.sourceModelId).name : file.name),
    };
  }
  history(cursor?: string, query?: string) {
    let before: { id: string; createdAt: string } | undefined;
    if (cursor) {
      const file = this.file(Uuid.parse(cursor));
      before = { id: file.id, createdAt: file.createdAt };
    }
    const page = this.files.repository.readySlices(25, before, query);
    const items = page.slice(0, 24).map((file) => ({
      id: file.id,
      name: file.displayName ?? this.files.metadata(file.sourceModelId!).name,
      createdAt: file.createdAt,
      format: file.format as 'gcode' | 'gcode.3mf',
      estimatedSeconds: file.estimatedSeconds,
      filamentGrams: file.filamentGrams,
    }));
    return { items, nextCursor: page.length > 24 ? items.at(-1)!.id : null };
  }
  async text(id: string) {
    const file = this.file(id);
    if (this.active >= 2)
      throw new AppError('preview_busy', 'Two previews are already being processed', 503);
    this.active++;
    let dir: string | undefined;
    try {
      const root = resolve(this.dataDir, 'preview-tmp');
      await mkdir(root, { recursive: true });
      dir = await mkdtemp(join(root, 'preview-'));
      const path = join(dir, 'source');
      await this.files.materialize(id, path);
      const stream = await openGcode(path, file.format, this.maxBytes),
        chunks: Buffer[] = [];
      let bytes = 0;
      try {
        for await (const chunk of stream) {
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > this.maxBytes)
            throw new AppError(
              'too_large',
              'Preview exceeds size limit; download the full artifact instead',
              413,
            );
          chunks.push(buffer);
        }
      } finally {
        stream.destroy();
      }
      const buffer = Buffer.concat(chunks, bytes);
      await inspectGcode(Readable.from(buffer));
      return buffer.toString('utf8');
    } finally {
      this.active--;
      if (dir)
        await rm(dir, { recursive: true, force: true }).catch((e) =>
          logError('preview_cleanup', id, e),
        );
    }
  }
  async recover() {
    await rm(resolve(this.dataDir, 'preview-tmp'), { recursive: true, force: true });
  }
}
