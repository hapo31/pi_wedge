import { readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Slicer, ModelFile, SliceResult, ParentPlateInput } from '../domain/contracts.js';
import type { SliceOptions } from '../domain/schemas.js';
import type { CommandRunner } from './command.js';
import type { Config } from '../config.js';
import { CommandError } from './command.js';
import { AppError } from '../domain/errors.js';
import { openGcode, inspectGcode, listPlates } from './gcode.js';
export class OrcaSlicerAdapter implements Slicer {
  constructor(
    private runner: CommandRunner,
    private config: Config,
  ) {}
  async slice(
    input: ModelFile,
    options: SliceOptions,
    parent?: ParentPlateInput,
  ): Promise<SliceResult> {
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
      'result.gcode.3mf',
      input.path,
    ];
    const log = await this.runner.run(
      this.config.ORCA_XVFB ? 'xvfb-run' : this.config.ORCA_BIN,
      this.config.ORCA_XVFB ? ['-a', this.config.ORCA_BIN, ...args] : args,
      input.workDir,
    );
    await writeFile(join(input.workDir, 'orca.log'), log.stdout + '\n' + log.stderr, {
      mode: 0o600,
    });
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
    if (parent) {
      const existing = await listPlates(parent.path);
      if (parent.plate !== existing.at(-1)! + 1)
        throw new AppError('slicer_output_invalid', 'Invalid next plate number', 422);
      const combined = join(input.workDir, 'combined.gcode.3mf');
      let log;
      try {
        log = await this.runner.run(
          this.config.FREECAD_PYTHON,
          [
            resolve('scripts/append-plate.py'),
            parent.path,
            path,
            combined,
            String(this.config.MAX_ARTIFACT_MB * 1048576),
          ],
          input.workDir,
        );
      } catch (error) {
        if (error instanceof CommandError && error.code === 'command_failed')
          throw new AppError(
            'container_append_failed',
            'Could not append plate to the parent print container',
            422,
          );
        throw error;
      }
      const plates = await listPlates(combined);
      if (
        JSON.stringify(plates) !== JSON.stringify([...existing, parent.plate]) ||
        plates.at(-1) !== parent.plate ||
        (await stat(combined)).size > this.config.MAX_ARTIFACT_MB * 1048576
      )
        throw new AppError('slicer_output_invalid', 'Invalid appended print container', 422);
      await inspectGcode(
        await openGcode(combined, 'gcode.3mf', this.config.MAX_ARTIFACT_MB * 1048576, parent.plate),
      );
      await writeFile(join(input.workDir, 'append.log'), log.stdout + '\n' + log.stderr, {
        mode: 0o600,
      });
      return { path: combined, format: 'gcode.3mf', plate: parent.plate, ...stats };
    }
    return { path, format: 'gcode.3mf', ...stats };
  }
}
