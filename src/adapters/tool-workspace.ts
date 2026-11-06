import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, stat, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { JobWorkspace } from '../domain/contracts.js';
import type { CommandRunner } from './command.js';
import type { Config } from '../config.js';
import { AppError } from '../domain/errors.js';

const TMPFS_MAGIC = 0x01021994;
const inside = (parent: string, child: string) => {
  const path = relative(parent, child);
  return !path || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
};
export class BoundedToolWorkspace implements JobWorkspace {
  private root: string;
  private owned: string;
  private device?: number;
  constructor(private config: Config) {
    this.root = resolve(config.TOOLS_WORKSPACE_DIR);
    const identity = createHash('sha256')
      .update(resolve(config.DATA_DIR))
      .digest('hex')
      .slice(0, 16);
    this.owned = join(this.root, `pi-wedge-${identity}`);
  }
  async check(directory?: string) {
    try {
      if (!isAbsolute(this.config.TOOLS_WORKSPACE_DIR) || (await realpath(this.root)) !== this.root)
        throw new Error('path');
      const info = await stat(this.root),
        parent = await stat(dirname(this.root)),
        fs = await statfs(this.root);
      if (
        !info.isDirectory() ||
        info.dev === parent.dev ||
        fs.type !== TMPFS_MAGIC ||
        fs.blocks <= 0 ||
        fs.bsize <= 0 ||
        fs.bsize * fs.blocks > this.config.TOOLS_WORKSPACE_MAX_MB * 1048576 ||
        (this.device !== undefined && info.dev !== this.device)
      )
        throw new Error('mount');
      for (const path of [this.config.DATA_DIR, this.config.PROFILE_DIR]) {
        const target = await realpath(resolve(path)).catch(() => resolve(path));
        if (inside(this.root, target) || inside(target, this.root)) throw new Error('overlap');
      }
      if (
        directory &&
        (!inside(this.owned, resolve(directory)) || resolve(directory) === this.owned)
      )
        throw new Error('directory');
      if (
        directory &&
        ((await realpath(directory)) !== resolve(directory) ||
          (await stat(directory)).dev !== info.dev)
      )
        throw new Error('directory');
      // Never follow an application subdirectory replaced by a symbolic link.
      const owned = await lstat(this.owned).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (owned && (!owned.isDirectory() || owned.dev !== info.dev)) throw new Error('owned');
      this.device = info.dev;
    } catch {
      throw new AppError(
        'tool_workspace_unavailable',
        'Configured tool workspace requires its dedicated bounded tmpfs mount',
        503,
      );
    }
  }
  async create() {
    await this.check();
    await mkdir(this.owned, { recursive: true, mode: 0o700 });
    return mkdtemp(join(this.owned, 'slice-'));
  }
  async remove(directory: string) {
    await this.check(directory);
    await rm(directory, { recursive: true, force: true });
  }
  async recover() {
    await this.check();
    await rm(this.owned, { recursive: true, force: true });
  }
}

export class WorkspaceCommandRunner implements CommandRunner {
  constructor(
    private runner: CommandRunner,
    private workspace: BoundedToolWorkspace,
  ) {}
  async run(command: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}) {
    await this.workspace.check(cwd);
    const home = join(cwd, '.tool-home'),
      temp = join(cwd, '.tool-tmp'),
      cache = join(cwd, '.tool-cache'),
      config = join(cwd, '.tool-config');
    for (const path of [home, temp, cache, config]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      if (!(await lstat(path)).isDirectory())
        throw new AppError(
          'tool_workspace_unavailable',
          'Tool workspace path is not a directory',
          503,
        );
    }
    return this.runner.run(command, args, cwd, {
      ...extraEnv,
      HOME: home,
      FREECAD_USER_HOME: home,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      XDG_CACHE_HOME: cache,
      XDG_CONFIG_HOME: config,
    });
  }
}
