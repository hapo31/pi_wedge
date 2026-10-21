import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Slicer, ModelConverter, ModelFile, ParentPlateInput } from '../domain/contracts.js';
import type { SliceOptions, SliceJob } from '../domain/schemas.js';
import { Uuid } from '../domain/schemas.js';
import { AppError, safeError, logError } from '../domain/errors.js';
import { CommandError } from '../adapters/command.js';
import { PreviewService } from './preview.js';
import { FileService } from './files.js';
export class JobService {
  private active = new Set<Promise<void>>();
  private stopping = false;
  constructor(
    private files: FileService,
    private slicer: Slicer,
    private converter: ModelConverter,
    private dataDir: string,
    private concurrency: number,
    private maxQueued: number,
  ) {}
  get(id: string): SliceJob {
    const job = this.files.repository.get('job', Uuid.parse(id));
    if (!job) throw new AppError('job_not_found', 'Slice job UUID does not exist', 404);
    const publicJob = { ...job };
    delete (publicJob as Partial<typeof job>).reservedResultId;
    return publicJob;
  }
  assertCapacity() {
    if (this.stopping) throw new AppError('shutting_down', 'Server is stopping', 503);
    if (
      this.files.repository.all('job').filter((j) => j.state === 'queued').length >= this.maxQueued
    )
      throw new AppError('queue_full', 'Slice queue is full', 409);
  }
  async validateParent(parentId: string) {
    const supplied = this.files.repository.get('file', Uuid.parse(parentId));
    if (supplied?.parentId)
      throw new AppError(
        'parent_slice_required',
        'Use the root preview UUID as parentId',
        400,
        supplied.parentId,
      );
    const preview = new PreviewService(this.files, this.dataDir, 32 * 1048576);
    const { group, selected, previews } = await preview.selection(parentId);
    if (parentId !== group.rootFileId || selected.id !== group.rootFileId)
      throw new AppError(
        'parent_slice_required',
        'Use the root preview UUID as parentId',
        400,
        group.rootFileId,
      );
    const file = this.files.ready(group.fileId);
    if (file.format !== 'gcode.3mf' || !file.sourceModelId)
      throw new AppError(
        'wrong_kind',
        'Parent must be a server-generated print container preview UUID',
        409,
      );
    if (Math.max(...previews.map((p) => p.plate)) >= 100)
      throw new AppError('plate_limit', 'Plate limit reached', 409);
    return group;
  }
  async createWithParent(modelId: string, options: SliceOptions, name?: string, parentId?: string) {
    if (parentId) await this.validateParent(parentId);
    return this.enqueue(modelId, options, name, parentId);
  }
  create(modelId: string, options: SliceOptions, name?: string): SliceJob {
    return this.enqueue(modelId, options, name);
  }
  private enqueue(
    modelId: string,
    options: SliceOptions,
    name?: string,
    parentId?: string,
  ): SliceJob {
    this.assertCapacity();
    const f = this.files.ready(modelId);
    if (f.format !== 'stl' && f.format !== 'step')
      throw new AppError('wrong_kind', 'Slicing requires an STL/STEP model UUID', 409);
    const job = {
      id: randomUUID(),
      modelId,
      ...(parentId ? { parentId } : {}),
      ...(name ? { name } : {}),
      options,
      state: 'queued' as const,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      resultFileId: null,
      error: null,
      reservedResultId: randomUUID(),
    };
    this.files.repository.insert('job', job);
    queueMicrotask(() => this.pump());
    return this.get(job.id);
  }
  private pump() {
    if (this.stopping) return;
    for (const job of this.files.repository.all('job').filter((j) => j.state === 'queued')) {
      if (this.active.size >= this.concurrency) break;
      job.state = 'running';
      job.startedAt = new Date().toISOString();
      this.files.repository.save('job', job);
      const task = this.run(job.id).finally(() => {
        this.active.delete(task);
        this.pump();
      });
      this.active.add(task);
      void task.catch((error) => logError('job_persistence', job.id, error));
    }
  }
  private async run(id: string) {
    const job = this.files.repository.get('job', id)!;
    let workDir: string | undefined;
    try {
      const root = resolve(this.dataDir, 'tmp');
      await mkdir(root, { recursive: true });
      workDir = await mkdtemp(join(root, 'slice-'));
      const f = this.files.ready(job.modelId);
      const path = join(workDir, `model.${f.format}`);
      await this.files.materialize(f.id, path);
      let input: ModelFile = { id: f.id, path, format: f.format as 'stl' | 'step', workDir };
      if (input.format === 'step') input = await this.converter.convert(input, job.options.mesh);
      let parent: ParentPlateInput | undefined;
      let parentFileId: string | undefined;
      if (job.parentId) {
        const group = await this.validateParent(job.parentId);
        parentFileId = group.fileId;
        const path = join(workDir, 'parent.gcode.3mf');
        await this.files.materialize(group.fileId, path);
        parent = {
          path,
          plate: Math.max(...this.files.repository.previews(group.id).map((p) => p.plate)) + 1,
        };
      }
      const result = parent
        ? await this.slicer.slice(input, job.options, parent)
        : await this.slicer.slice(input, job.options);
      if (parent && (result.format !== 'gcode.3mf' || result.plate !== parent.plate))
        throw new AppError(
          'slicer_output_invalid',
          'Slicer did not append the requested plate',
          422,
        );
      const artifact = await this.files.saveResult(
        job.reservedResultId,
        result.path,
        f.id,
        job.options,
        result,
        result.format,
        job.name,
        job.parentId,
        result.plate,
      );
      job.resultFileId = artifact.id;
      job.state = 'succeeded';
      if (job.parentId) {
        this.files.repository.transaction(() => {
          const group = this.files.repository.plateSetForFile(job.parentId!)!;
          if (group.fileId !== parentFileId)
            throw new AppError('parent_changed', 'Parent changed during slicing', 409);
          group.fileId = artifact.id;
          this.files.repository.save('plateSet', group);
          this.files.repository.insert('platePreview', {
            id: artifact.id,
            plateId: group.id,
            fileId: artifact.id,
            plate: result.plate!,
            sourcePlate: result.plate!,
          });
          job.plateId = group.id;
          job.plate = result.plate!;
          job.finishedAt = new Date().toISOString();
          this.files.repository.save('job', job);
        });
      }
    } catch (error) {
      job.state = 'failed';
      job.resultFileId = null;
      delete job.plateId;
      delete job.plate;
      job.error = safeError(error);
      logError('slice', id, error);
      if (error instanceof CommandError) {
        try {
          await mkdir(resolve(this.dataDir, 'logs'), { recursive: true });
          await writeFile(resolve(this.dataDir, 'logs', `${id}.log`), error.log, { mode: 0o600 });
        } catch (e) {
          logError('job_log', id, e);
        }
      }
      await this.files.abandon(job.reservedResultId).catch((e) => logError('job_cleanup', id, e));
    } finally {
      job.finishedAt = new Date().toISOString();
      this.files.repository.save('job', job);
      if (workDir) {
        const logs = [];
        for (const name of ['freecad.log', 'orca.log', 'append.log']) {
          try {
            logs.push(name + '\n' + (await readFile(join(workDir, name), 'utf8')));
          } catch {
            /* Tool was not invoked or failed before logging. */
          }
        }
        if (logs.length) {
          try {
            await mkdir(resolve(this.dataDir, 'logs'), { recursive: true });
            await writeFile(resolve(this.dataDir, 'logs', `${id}.log`), logs.join('\n'), {
              mode: 0o600,
            });
          } catch (e) {
            logError('job_log', id, e);
          }
        }
      }
      if (workDir)
        await rm(workDir, { recursive: true, force: true }).catch((e) =>
          logError('temp_cleanup', id, e),
        );
    }
  }
  async recover() {
    // No other process may own DATA_DIR; stale workspaces belong to interrupted jobs.
    await rm(resolve(this.dataDir, 'tmp'), { recursive: true, force: true });
    for (const job of this.files.repository.all('job').filter((j) => j.state === 'running')) {
      await this.files.abandon(job.reservedResultId);
      job.state = 'failed';
      job.resultFileId = null;
      delete job.plateId;
      delete job.plate;
      job.error = { code: 'interrupted_job', message: 'Slice job interrupted by server restart' };
      job.finishedAt = new Date().toISOString();
      this.files.repository.save('job', job);
    }
    this.pump();
  }
  async stop() {
    this.stopping = true;
    await Promise.all(this.active);
  }
  async idle() {
    while (this.active.size || this.files.repository.all('job').some((j) => j.state === 'queued')) {
      this.pump();
      await Promise.all(this.active);
    }
  }
}
