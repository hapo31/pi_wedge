import { writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ModelConverter, ModelFile } from '../domain/contracts.js';
import type { SliceOptions } from '../domain/schemas.js';
import type { CommandRunner } from './command.js';
import { AppError } from '../domain/errors.js';
export class FreeCadConverter implements ModelConverter {
  constructor(
    private runner: CommandRunner,
    private python: string,
    private modulePath: string,
    private maxBytes: number,
  ) {}
  async convert(input: ModelFile, options: SliceOptions['mesh']): Promise<ModelFile> {
    const path = join(input.workDir, 'converted.stl'),
      config = join(input.workDir, 'conversion.json');
    await writeFile(
      config,
      JSON.stringify({ input: input.path, output: path, modulePath: this.modulePath, ...options }),
      { mode: 0o600 },
    );
    await this.runner.run(this.python, [resolve('scripts/step-to-stl.py')], input.workDir, {
      PI_WEDGE_CONVERSION_CONFIG: config,
    });
    const size = (await stat(path)).size;
    if (!size || size > this.maxBytes)
      throw new AppError(
        'conversion_invalid',
        'STEP conversion produced an invalid or oversized mesh',
        422,
      );
    return { ...input, path, format: 'stl' };
  }
}
