import { resolve } from 'node:path';
import type { Config } from './config.js';
import { Repository } from './adapters/repository.js';
import { S3Storage, LocalStorage } from './adapters/storage.js';
import { ProcessRunner } from './adapters/command.js';
import { OrcaSlicerAdapter } from './adapters/orca.js';
import { FreeCadConverter } from './adapters/converter.js';
import { BambuLanPrinter, DisabledPrinter } from './adapters/printer.js';
import { FileService } from './services/files.js';
import { JobService } from './services/jobs.js';
import { PrinterService } from './services/printer.js';
export interface Services {
  files: FileService;
  jobs: JobService;
  printer: PrinterService;
  config: Config;
}
export async function bootstrap(config: Config) {
  const repository = new Repository(resolve(config.DATA_DIR, 'metadata.sqlite'));
  const storage =
    config.STORAGE_BACKEND === 's3'
      ? new S3Storage(config)
      : new LocalStorage(resolve(config.DATA_DIR, 'objects'));
  const files = new FileService(
    repository,
    storage,
    config.MAX_UPLOAD_MB * 1048576,
    config.MAX_ARTIFACT_MB * 1048576,
  );
  const runner = new ProcessRunner(config.COMMAND_TIMEOUT_MS);
  const jobs = new JobService(
    files,
    new OrcaSlicerAdapter(runner, config),
    new FreeCadConverter(
      runner,
      config.FREECAD_PYTHON,
      config.FREECAD_MODULE_PATH,
      config.MAX_ARTIFACT_MB * 1048576,
    ),
    config.DATA_DIR,
    config.SLICE_CONCURRENCY,
    config.MAX_QUEUED_JOBS,
  );
  const printer = new PrinterService(
    files,
    config.PRINTER_ENABLED ? new BambuLanPrinter(config) : new DisabledPrinter(),
    config.DATA_DIR,
  );
  // A unavailable storage must not prevent liveness/docs; keep API disabled until recovery succeeds.
  let ready = false;
  try {
    await storage.check();
    await files.recover();
    await printer.recover();
    await jobs.recover();
    ready = true;
  } catch {
    console.error(
      'Dependency recovery failed; data APIs are disabled. Restart after restoring storage.',
    );
  }
  return {
    files,
    jobs,
    printer,
    config,
    ready,
    async close() {
      await jobs.stop();
      await printer.stop();
      repository.close();
      if (storage instanceof S3Storage) storage.close();
    },
  };
}
