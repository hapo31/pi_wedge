import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Slicer, ModelConverter, ModelFile } from '../domain/contracts.js';
import type { SliceOptions, SliceJob } from '../domain/schemas.js';
import { Uuid } from '../domain/schemas.js';
import { AppError, safeError, logError } from '../domain/errors.js';
import { CommandError } from '../adapters/command.js';
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
  create(modelId: string, options: SliceOptions): SliceJob {
    this.assertCapacity();
    const f = this.files.ready(modelId);
    if (f.format !== 'stl' && f.format !== 'step')
      throw new AppError('wrong_kind', 'Slicing requires an STL/STEP model UUID', 409);
    const job = {
      id: randomUUID(),
      modelId,
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
      const result = await this.slicer.slice(input, job.options);
      const artifact = await this.files.saveResult(
        job.reservedResultId,
        result.path,
        f.id,
        job.options,
        result,
        result.format,
      );
      job.resultFileId = artifact.id;
      job.state = 'succeeded';
    } catch (error) {
      job.state = 'failed';
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
