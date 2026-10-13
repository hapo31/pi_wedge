import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Slicer, ModelFile, SliceResult } from '../domain/contracts.js';
import type { SliceOptions } from '../domain/schemas.js';
import type { CommandRunner } from './command.js';
import type { Config } from '../config.js';
import { AppError } from '../domain/errors.js';
import { openGcode, inspectGcode } from './gcode.js';
export class OrcaSlicerAdapter implements Slicer {
  constructor(
    private runner: CommandRunner,
    private config: Config,
  ) {}
  async slice(input: ModelFile, options: SliceOptions): Promise<SliceResult> {
    const dir = resolve(this.config.PROFILE_DIR);
    let processProfile: Record<string, unknown>;
    try {
      const machine = JSON.parse(await readFile(join(dir, 'machine.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      const filament = JSON.parse(await readFile(join(dir, 'filament.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      processProfile = JSON.parse(await readFile(join(dir, 'process.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      if (
        machine.printer_model !== 'Bambu Lab A1 mini' ||
        JSON.stringify(machine.nozzle_diameter) !== '["0.4"]' ||
        filament.inherits ||
        machine.inherits ||
        processProfile.inherits
      )
        throw new Error('invalid');
    } catch {
      throw new AppError(
        'profiles_unavailable',
        'Prepare flattened A1 mini profiles before slicing',
        503,
      );
    }
    const processPath = join(input.workDir, 'process.json');
    const overrides: Record<string, unknown> = {
      layer_height: String(options.layerHeight),
      sparse_infill_density: `${options.infillDensity}%`,
      enable_support: options.support ? '1' : '0',
      curr_bed_type: 'Textured PEI Plate',
      enable_arc_fitting: '0',
    };
    if (options.settings.wallLoops !== undefined)
      overrides.wall_loops = String(options.settings.wallLoops);
    if (options.settings.topShellLayers !== undefined)
      overrides.top_shell_layers = String(options.settings.topShellLayers);
    if (options.settings.bottomShellLayers !== undefined)
      overrides.bottom_shell_layers = String(options.settings.bottomShellLayers);
    await writeFile(processPath, JSON.stringify({ ...processProfile, ...overrides }), {
      mode: 0o600,
    });
    const path = join(input.workDir, 'result.gcode.3mf');
    const args = [
      '--load-settings',
      `${join(dir, 'machine.json')};${processPath}`,
      '--load-filaments',
      join(dir, 'filament.json'),
      '--datadir',
      join(input.workDir, 'orca-config'),
      '--slice',
      '1',
      '--outputdir',
      input.workDir,
      '--export-3mf',
      path,
      input.path,
    ];
    await this.runner.run(
      this.config.ORCA_XVFB ? 'xvfb-run' : this.config.ORCA_BIN,
      this.config.ORCA_XVFB ? ['-a', this.config.ORCA_BIN, ...args] : args,
      input.workDir,
    );
    try {
      const size = (await stat(path)).size;
      if (!size || size > this.config.MAX_ARTIFACT_MB * 1048576) throw new Error('size');
    } catch {
      throw new AppError(
        'slicer_output_invalid',
        'Orca did not produce a valid-sized print container',
        422,
      );
    }
    const stats = await inspectGcode(
      await openGcode(path, 'gcode.3mf', this.config.MAX_ARTIFACT_MB * 1048576),
    );
    return { path, format: 'gcode.3mf', ...stats };
  }
}
