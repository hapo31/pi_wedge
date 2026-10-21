import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Printer } from '../domain/contracts.js';
import type {
  PrintOptions,
  PrintOperation,
  StopPrintOperation,
  PrinterStatus,
} from '../domain/schemas.js';
import { Uuid } from '../domain/schemas.js';
import { AppError, safeError, logError } from '../domain/errors.js';
import { listPlates } from '../adapters/gcode.js';
import { FileService } from './files.js';
export class PrinterService {
  private busy = false;
  private snapshot: PrinterStatus | null = null;
  private statusRequest: Promise<PrinterStatus> | null = null;
  async status(fresh = false): Promise<PrinterStatus> {
    if (!fresh && this.snapshot && Date.now() - Date.parse(this.snapshot.observedAt) < 5000)
      return this.snapshot;
    if (this.statusRequest) return this.statusRequest;
    this.statusRequest = this.printer
      .readStatus()
      .then((status) => {
        this.snapshot = status;
        return status;
      })
      .finally(() => {
        this.statusRequest = null;
      });
    return this.statusRequest;
  }
  constructor(
    private files: FileService,
    private printer: Printer,
    private dataDir: string,
  ) {}
  private file(id: string) {
    const file = this.files.ready(id);
    if (file.format !== 'gcode.3mf' || !file.sourceModelId)
      throw new AppError(
        'wrong_kind',
        'A1 mini printing requires a server-generated gcode.3mf UUID',
        409,
      );
    return file;
  }
  private async withFile<T>(id: string, fn: (path: string) => Promise<T>) {
    const root = resolve(this.dataDir, 'printer-tmp');
    await mkdir(root, { recursive: true });
    const dir = await mkdtemp(join(root, 'transfer-'));
    try {
      const path = join(dir, 'artifact.gcode.3mf');
      await this.files.materialize(id, path);
      return await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch((e) =>
        logError('printer_cleanup', id, e),
      );
    }
  }
  async upload(fileId: string) {
    const file = this.file(fileId);
    if (this.busy)
      throw new AppError('printer_busy', 'Another printer operation is in progress', 409);
    this.busy = true;
    try {
      return {
        fileId,
        ...(await this.withFile(fileId, (path) => this.printer.upload(file, path))),
      };
    } finally {
      this.busy = false;
    }
  }
  get(id: string) {
    const uuid = Uuid.parse(id);
    const op =
      this.files.repository.get('operation', uuid) ??
      this.files.repository.get('stopOperation', uuid);
    if (!op) throw new AppError('operation_not_found', 'Print operation UUID does not exist', 404);
    return op;
  }
  private operations() {
    return [
      ...this.files.repository.all('operation'),
      ...this.files.repository.all('stopOperation'),
    ];
  }
  private saveOperation(op: PrintOperation | StopPrintOperation) {
    if ('action' in op) this.files.repository.save('stopOperation', op);
    else this.files.repository.save('operation', op);
  }
  async print(fileId: string, options: PrintOptions, key: string): Promise<PrintOperation> {
    Uuid.parse(key);
    if (this.files.repository.get('stopOperation', key))
      throw new AppError(
        'idempotency_conflict',
        'This Idempotency-Key was used for a stop request',
        409,
      );
    const existing = this.files.repository.get('operation', key);
    if (existing) {
      if (
        existing.fileId !== fileId ||
        JSON.stringify(existing.options) !== JSON.stringify(options)
      )
        throw new AppError(
          'idempotency_conflict',
          'This Idempotency-Key was used for a different request',
          409,
        );
      return existing;
    }
    const file = this.file(fileId);
    if (this.busy)
      throw new AppError('printer_busy', 'Another printer operation is in progress', 409);
    if (this.operations().some((o) => o.state === 'unknown' || o.state === 'pending'))
      throw new AppError(
        'printer_outcome_unknown',
        'An earlier print operation has an unknown outcome. Resolve it before another print.',
        409,
      );
    this.busy = true;
    const operation: PrintOperation = {
      id: key,
      fileId,
      options,
      state: 'pending',
      createdAt: new Date().toISOString(),
      error: null,
    };
    this.files.repository.insert('operation', operation);
    let dispatched = false;
    try {
      if (options.useAms) {
        const status = await this.status(true),
          slot = status.slots.find((s) => s.slot === options.amsMapping?.[0]);
        if (status.amsConnected !== true || slot?.present !== true)
          throw new AppError(
            'ams_slot_unavailable',
            'Selected AMS slot is empty or its state is unknown',
            409,
          );
        if (slot.material && slot.material.toUpperCase() !== 'PLA')
          throw new AppError(
            'ams_material_mismatch',
            'Selected AMS material does not match the Generic PLA slice',
            409,
          );
      }
      await this.withFile(fileId, async (path) => {
        if (!(await listPlates(path)).includes(options.plate))
          throw new AppError('plate_not_found', 'Plate does not exist', 404);
        const { remotePath } = await this.printer.upload(file, path);
        dispatched = true;
        await this.printer.startPrint(remotePath, options, key);
      });
      operation.state = 'accepted';
    } catch (error) {
      operation.state =
        (error instanceof AppError && error.code === 'printer_outcome_unknown') ||
        (dispatched && !(error instanceof AppError))
          ? 'unknown'
          : 'failed';
      operation.error =
        operation.state === 'unknown'
          ? {
              code: 'printer_outcome_unknown',
              message: 'Print command outcome is unknown. Check the printer before retrying.',
            }
          : safeError(error);
      logError('printer', key, error);
    } finally {
      this.files.repository.save('operation', operation);
      this.busy = false;
    }
    return operation;
  }
  async stopPrint(key: string): Promise<StopPrintOperation> {
    Uuid.parse(key);
    if (this.files.repository.get('operation', key))
      throw new AppError(
        'idempotency_conflict',
        'This Idempotency-Key was used for a print request',
        409,
      );
    const existing = this.files.repository.get('stopOperation', key);
    if (existing) return existing;
    if (this.busy)
      throw new AppError('printer_busy', 'Another printer operation is in progress', 409);
    if (
      this.files.repository
        .all('stopOperation')
        .some((o) => o.state === 'pending' || o.state === 'unknown')
    )
      throw new AppError(
        'printer_outcome_unknown',
        'An earlier stop operation has an unknown outcome. Resolve it before another stop.',
        409,
      );
    // An unresolved start must not prevent an explicit stop. It remains unresolved
    // afterwards: a stop ACK cannot establish whether that start was accepted.
    const operation: StopPrintOperation = {
      id: key,
      action: 'stop',
      state: 'pending',
      createdAt: new Date().toISOString(),
      error: null,
    };
    this.files.repository.insert('stopOperation', operation);
    this.busy = true;
    try {
      await this.printer.stopPrint(key);
      operation.state = 'accepted';
    } catch (error) {
      operation.state =
        !(error instanceof AppError) || error.code === 'printer_outcome_unknown'
          ? 'unknown'
          : 'failed';
      operation.error =
        operation.state === 'unknown'
          ? {
              code: 'printer_outcome_unknown',
              message: 'Stop command outcome is unknown. Check the printer before retrying.',
            }
          : safeError(error);
      logError('printer_stop', key, error);
    } finally {
      this.saveOperation(operation);
      this.busy = false;
    }
    return operation;
  }
  resolveUnknown(id: string, outcome: 'accepted' | 'failed', note: string) {
    const op = this.get(id);
    if (op.state !== 'unknown')
      throw new AppError('operation_not_unknown', 'Only an unknown operation can be resolved', 409);
    op.state = outcome;
    op.error =
      outcome === 'failed'
        ? {
            code: 'manually_resolved',
            message:
              'action' in op
                ? 'Administrator confirmed stop was not accepted'
                : 'Administrator confirmed print did not start',
          }
        : null;
    this.saveOperation(op);
    console.info(
      JSON.stringify({
        event: 'print_outcome_resolved',
        operationId: id,
        outcome,
        noteLength: note.length,
      }),
    );
    return op;
  }
  async recover() {
    await rm(resolve(this.dataDir, 'printer-tmp'), { recursive: true, force: true });
    for (const operation of this.operations().filter((o) => o.state === 'pending')) {
      operation.state = 'unknown';
      operation.error = {
        code: 'printer_outcome_unknown',
        message:
          'Server stopped during printer command dispatch. Check the printer before retrying.',
      };
      this.saveOperation(operation);
    }
  }
  async stop() {
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
