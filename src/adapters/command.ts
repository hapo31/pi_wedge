import { spawn } from 'node:child_process';
import { AppError } from '../domain/errors.js';
export class CommandError extends AppError {
  constructor(
    code: string,
    message: string,
    public readonly log: string,
  ) {
    super(code, message, 503);
  }
}
export interface CommandRunner {
  run(
    command: string,
    args: string[],
    cwd: string,
    extraEnv?: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string }>;
}
export class ProcessRunner implements CommandRunner {
  constructor(
    private timeout: number,
    private maxLogBytes = 65536,
  ) {}
  run(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...extraEnv };
      for (const key of [
        'PATH',
        'LANG',
        'LC_ALL',
        'DISPLAY',
        'XAUTHORITY',
        'LD_LIBRARY_PATH',
        'FONTCONFIG_PATH',
      ])
        if (process.env[key]) env[key] = process.env[key];
      const child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        detached: process.platform === 'linux',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '',
        stderr = '',
        timedOut = false;
      const append = (current: string, chunk: Buffer) =>
        Buffer.from(current + chunk.toString())
          .subarray(-this.maxLogBytes)
          .toString();
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        if (child.pid) {
          try {
            if (process.platform === 'linux') process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }, this.timeout);
      child.on('error', () => {
        clearTimeout(timer);
        reject(
          new CommandError(
            'command_unavailable',
            'Configured external tool could not start',
            `${stdout}\n${stderr}`,
          ),
        );
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut)
          reject(
            new CommandError(
              'command_timeout',
              'External tool exceeded its time limit',
              `${stdout}\n${stderr}`,
            ),
          );
        else if (code !== 0)
          reject(
            new CommandError(
              'command_failed',
              `External tool exited unsuccessfully (${code})`,
              `${stdout}\n${stderr}`,
            ),
          );
        else resolve({ stdout, stderr });
      });
    });
  }
}
