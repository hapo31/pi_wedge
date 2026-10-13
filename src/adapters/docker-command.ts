import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { CommandRunner } from './command.js';
import { CommandError, ProcessRunner } from './command.js';
import { AppError, logError } from '../domain/errors.js';
import type { Config } from '../config.js';
export class DockerCommandRunner implements CommandRunner {
  private readonly label: string;
  constructor(
    private runner: CommandRunner,
    private config: Config,
    private cleanupRunner: CommandRunner = new ProcessRunner(10000),
  ) {
    this.label = `pi_wedge.data_dir=${resolve(config.DATA_DIR)}`;
  }
  async run(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
    const name = `pi-wedge-tool-${randomUUID()}`;
    const mounts = [
      resolve(cwd),
      resolve(this.config.PROFILE_DIR),
      resolve('scripts/step-to-stl.py'),
    ];
    const dockerArgs = [
      'run',
      '--pull',
      'never',
      '--rm',
      '--name',
      name,
      '--label',
      this.label,
      '--network',
      'none',
      '--pids-limit',
      '256',
      '--memory',
      '4g',
      '--cpus',
      '3',
      '--workdir',
      resolve(cwd),
    ];
    for (const path of new Set(mounts))
      dockerArgs.push(
        '--mount',
        `type=bind,src=${path},dst=${path}${path === resolve(cwd) ? '' : ',readonly'}`,
      );
    for (const [key, value] of Object.entries(extraEnv))
      dockerArgs.push('--env', `${key}=${value}`);
    dockerArgs.push(this.config.TOOLS_IMAGE, command, ...args);
    try {
      return await this.runner.run('docker', dockerArgs, cwd);
    } finally {
      await this.remove(name, cwd);
    }
  }
  private async remove(id: string, cwd: string) {
    try {
      await this.cleanupRunner.run('docker', ['rm', '-f', id], cwd);
    } catch (error) {
      if (!(error instanceof CommandError && /No such container/i.test(error.log))) {
        logError('tool_container_cleanup', id, error);
        throw new AppError(
          'tool_cleanup_failed',
          'Could not remove an isolated tool container',
          503,
        );
      }
    }
  }
  async recover() {
    const { stdout } = await this.cleanupRunner.run(
      'docker',
      ['ps', '-aq', '--filter', `label=${this.label}`],
      resolve(this.config.DATA_DIR),
    );
    for (const id of stdout.trim().split(/\s+/).filter(Boolean)) {
      if (!/^[a-f0-9]{12,64}$/.test(id))
        throw new AppError('invalid_container_id', 'Unexpected Docker recovery response', 503);
      await this.remove(id, resolve(this.config.DATA_DIR));
    }
  }
}
