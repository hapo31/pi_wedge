import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { openGcode, inspectGcode } from '../adapters/gcode.js';
import { AppError, logError } from '../domain/errors.js';
import { FileService } from './files.js';
export class PreviewService {
  private active = 0;
  constructor(
    private files: FileService,
    private dataDir: string,
    private maxBytes: number,
  ) {}
  async text(id: string) {
    const file = this.files.ready(id);
    if (file.format !== 'gcode' && file.format !== 'gcode.3mf')
      throw new AppError('wrong_kind', 'Preview requires a G-code slice result UUID', 409);
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
      const text = buffer.toString('utf8');
      let lines = 0;
      for (let i = 0; i < text.length; i++)
        if (text[i] === '\n' && ++lines > 250000)
          throw new AppError(
            'too_large',
            'Preview exceeds 250,000 lines; download the full artifact instead',
            413,
          );
      return text;
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
