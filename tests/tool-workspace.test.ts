import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readConfig } from '../src/config.js';
import { BoundedToolWorkspace, WorkspaceCommandRunner } from '../src/adapters/tool-workspace.js';
import { TOKEN } from './helpers.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat), statfs: vi.fn(actual.statfs) };
});
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) await fs.rm(path, { recursive: true, force: true });
});
async function mountedWorkspace() {
  const base = await fs.mkdtemp(join(tmpdir(), 'pi-wedge-workspace-test-'));
  directories.push(base);
  const root = join(base, 'mount');
  await fs.mkdir(root);
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const parent = await actual.stat(base);
  vi.mocked(fs.stat).mockImplementation((async (path: string) => {
    const value = await actual.stat(path);
    return path === base ? Object.assign(value, { dev: parent.dev + 1 }) : value;
  }) as typeof fs.stat);
  vi.mocked(fs.statfs).mockResolvedValue({
    type: 0x01021994,
    bsize: 4096,
    frsize: 4096,
    blocks: 256,
    bfree: 256,
    bavail: 256,
    files: 256,
    ffree: 256,
  });
  const config = readConfig({
    API_TOKEN: TOKEN,
    STORAGE_BACKEND: 'local',
    DATA_DIR: join(base, 'data'),
    PROFILE_DIR: join(base, 'profiles'),
    TOOLS_WORKSPACE_DIR: root,
    TOOLS_WORKSPACE_MAX_MB: '1',
  });
  return { base, root, config, workspace: new BoundedToolWorkspace(config) };
}
it('requires a separate bounded tmpfs mount and refuses an absent or oversized mount', async () => {
  const { root, workspace } = await mountedWorkspace();
  await workspace.check();
  vi.mocked(fs.statfs).mockResolvedValueOnce({
    ...(await fs.statfs(root)),
    blocks: 257,
  });
  await expect(workspace.check()).rejects.toMatchObject({ code: 'tool_workspace_unavailable' });
  vi.mocked(fs.statfs).mockResolvedValueOnce({ ...(await fs.statfs(root)), type: 0xef53 });
  await expect(workspace.create()).rejects.toMatchObject({ code: 'tool_workspace_unavailable' });
  vi.mocked(fs.statfs).mockResolvedValueOnce({ ...(await fs.statfs(root)), blocks: 0 });
  await expect(workspace.check()).rejects.toMatchObject({ code: 'tool_workspace_unavailable' });
});
it('keeps the mount and unrelated files while recovering only its own interrupted jobs', async () => {
  const { root, workspace } = await mountedWorkspace();
  await fs.writeFile(join(root, 'administrator'), 'keep');
  const first = await workspace.create();
  const second = await workspace.create();
  await fs.writeFile(join(first, 'partial'), 'partial');
  await workspace.remove(second);
  await expect(workspace.remove(root)).rejects.toMatchObject({
    code: 'tool_workspace_unavailable',
  });
  await expect(workspace.remove(join(first, '..'))).rejects.toMatchObject({
    code: 'tool_workspace_unavailable',
  });
  await workspace.recover();
  expect(await fs.readdir(root)).toEqual(['administrator']);
  expect(await workspace.create()).toContain(root);
});
it('rejects overlapping data/profiles and symbolic links before deleting any files', async () => {
  const { root, base, config } = await mountedWorkspace();
  await expect(
    new BoundedToolWorkspace({ ...config, DATA_DIR: base }).recover(),
  ).rejects.toMatchObject({ code: 'tool_workspace_unavailable' });
  await expect(
    new BoundedToolWorkspace({ ...config, PROFILE_DIR: join(root, 'profiles') }).check(),
  ).rejects.toMatchObject({ code: 'tool_workspace_unavailable' });
  const link = join(base, 'link');
  await fs.symlink(root, link);
  await expect(
    new BoundedToolWorkspace({ ...config, TOOLS_WORKSPACE_DIR: link }).check(),
  ).rejects.toMatchObject({ code: 'tool_workspace_unavailable' });
});
it('collects tool temporary/home/cache paths and rejects mount loss before invoking a command', async () => {
  const { root, workspace } = await mountedWorkspace(),
    cwd = await workspace.create(),
    runner = { run: vi.fn(async () => ({ stdout: '', stderr: '' })) },
    isolated = new WorkspaceCommandRunner(runner, workspace);
  await isolated.run('configured-tool', ['fixed'], cwd, { CONVERSION_CONFIG: 'configuration' });
  expect(runner.run).toHaveBeenCalledWith('configured-tool', ['fixed'], cwd, {
    CONVERSION_CONFIG: 'configuration',
    HOME: join(cwd, '.tool-home'),
    FREECAD_USER_HOME: join(cwd, '.tool-home'),
    TMPDIR: join(cwd, '.tool-tmp'),
    TMP: join(cwd, '.tool-tmp'),
    TEMP: join(cwd, '.tool-tmp'),
    XDG_CACHE_HOME: join(cwd, '.tool-cache'),
    XDG_CONFIG_HOME: join(cwd, '.tool-config'),
  });
  vi.mocked(fs.statfs).mockResolvedValue({ ...(await fs.statfs(root)), type: 0xef53 });
  await expect(isolated.run('configured-tool', [], cwd)).rejects.toMatchObject({
    code: 'tool_workspace_unavailable',
  });
  expect(runner.run).toHaveBeenCalledOnce();
});
it('refuses tool-created links before a later command can mount a host directory as temporary storage', async () => {
  const { base, workspace } = await mountedWorkspace(),
    cwd = await workspace.create(),
    runner = { run: vi.fn(async () => ({ stdout: '', stderr: '' })) };
  await fs.symlink(base, join(cwd, '.tool-tmp'));
  await expect(
    new WorkspaceCommandRunner(runner, workspace).run('tool', [], cwd),
  ).rejects.toMatchObject({
    code: 'tool_workspace_unavailable',
  });
  expect(runner.run).not.toHaveBeenCalled();
});
