import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { openGcode, inspectGcode, listPlates } from '../adapters/gcode.js';
import { AppError, logError } from '../domain/errors.js';
import { FileService } from './files.js';
import { PlateNumber, Uuid } from '../domain/schemas.js';
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
  async selection(id: string, previewId?: string) {
    Uuid.parse(id);
    const repository = this.files.repository;
    let group = repository.get('plateSet', id);
    if (!group) {
      const selected = repository.get('platePreview', id);
      if (selected) {
        group = repository.get('plateSet', selected.plateId);
        previewId ??= selected.id;
      }
    }
    if (!group) {
      const file = this.file(id);
      group = repository.plateSetForFile(file.id);
      if (!group) {
        const numbers = await this.withFile(file.id, (path) =>
          file.format === 'gcode.3mf' ? listPlates(path) : Promise.resolve([1]),
        );
        // Concurrent initial reads may finish materializing the same file together.
        group = repository.plateSetForFile(file.id);
        if (!group) {
          group = {
            id: randomUUID(),
            rootFileId: file.id,
            fileId: file.id,
            createdAt: file.createdAt,
          };
          const created = group;
          repository.transaction(() => {
            repository.insert('plateSet', created);
            for (const [index, plate] of numbers.entries())
              repository.insert('platePreview', {
                id: index === 0 ? file.id : randomUUID(),
                plateId: created.id,
                fileId: file.id,
                plate,
                sourcePlate: plate,
              });
          });
        }
      }
    }
    const previews = repository.previews(group.id);
    const selected = previewId ? previews.find((p) => p.id === Uuid.parse(previewId)) : previews[0];
    if (!selected)
      throw new AppError('plate_not_found', 'Preview does not belong to this plate', 404);
    this.file(selected.fileId);
    return { group, selected, previews };
  }
  async details(id: string, previewId?: string) {
    const { group, selected, previews } = await this.selection(id, previewId);
    const file = this.file(selected.fileId);
    return this.withFile(file.id, async (path) => {
      let stats = {
        estimatedSeconds: null as number | null,
        filamentGrams: null as number | null,
        filamentMillimeters: null as number | null,
      };
      try {
        stats = await inspectGcode(
          await openGcode(path, file.format, this.maxBytes, selected.sourcePlate),
        );
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'too_large')) throw error;
      }
      return {
        file: {
          id: file.id,
          name: file.name,
          format: file.format,
          state: 'ready' as const,
          ...stats,
        },
        plateId: group.id,
        previewId: selected.id,
        plate: selected.plate,
        plates: previews.map(({ id, plate }) => ({ id, plate })),
        displayName:
          file.displayName ??
          (file.sourceModelId ? this.files.metadata(file.sourceModelId).name : file.name),
      };
    });
  }
  async selectedText(id: string, previewId?: string) {
    const { selected } = await this.selection(id, previewId);
    return this.text(selected.fileId, selected.sourcePlate);
  }
  private assertPlate(plates: number[], plate: number) {
    PlateNumber.parse(plate);
    if (!plates.includes(plate)) throw new AppError('plate_not_found', 'Plate does not exist', 404);
  }
  async history(cursor?: string, query?: string) {
    let before: { id: string; createdAt: string } | undefined;
    if (cursor) {
      const file = this.file(Uuid.parse(cursor));
      before = { id: file.id, createdAt: file.createdAt };
    }
    const page = this.files.repository.readySlices(25, before, query);
    const items = [];
    for (const file of page.slice(0, 24)) {
      const { group, previews } = await this.selection(file.id);
      items.push({
        id: file.id,
        plateId: group.id,
        previewId: previews.find((p) => p.id === file.id)?.id ?? previews[0]!.id,
        plateCount: previews.length,
        name: file.displayName ?? this.files.metadata(file.sourceModelId!).name,
        createdAt: file.createdAt,
        format: file.format as 'gcode' | 'gcode.3mf',
        estimatedSeconds: file.estimatedSeconds,
        filamentGrams: file.filamentGrams,
      });
    }
    return { items, nextCursor: page.length > 24 ? items.at(-1)!.id : null };
  }
  async text(id: string, plate?: number) {
    const file = this.file(id);
    return this.withFile(id, async (path) => {
      const plates = file.format === 'gcode.3mf' ? await listPlates(path) : [1];
      const selected = plate ?? plates[0]!;
      this.assertPlate(plates, selected);
      const stream = await openGcode(path, file.format, this.maxBytes, selected),
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
    });
  }
  private async withFile<T>(id: string, fn: (path: string) => Promise<T>) {
    this.file(id);
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
      return await fn(path);
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
