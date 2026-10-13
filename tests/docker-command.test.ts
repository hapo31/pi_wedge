import { expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { DockerCommandRunner } from '../src/adapters/docker-command.js';
import { CommandError } from '../src/adapters/command.js';
import { TOKEN } from './helpers.js';
const config = readConfig({
  API_TOKEN: TOKEN,
  STORAGE_BACKEND: 'local',
  DATA_DIR: '/tmp/isolated-data',
  PROFILE_DIR: '/tmp/trusted-profiles',
});
it('isolates the command, mounts only job/profiles/converter, and always cleans its container', async () => {
  const runner = { run: vi.fn(async () => ({ stdout: 'ok', stderr: '' })) },
    cleanup = { run: vi.fn(async () => ({ stdout: '', stderr: '' })) };
  await new DockerCommandRunner(runner, config, cleanup).run(
    '/opt/squashfs-root/AppRun',
    ['--slice', '1'],
    '/tmp/isolated-data/tmp/job',
  );
  const args = runner.run.mock.calls[0] as unknown as [string, string[], string];
  expect(args[0]).toBe('docker');
  expect(args[1]).toEqual(
    expect.arrayContaining([
      '--network',
      'none',
      '--memory',
      '4g',
      '--cpus',
      '3',
      'pi-wedge-tools:0.1',
      '--slice',
      '1',
    ]),
  );
  expect(args[1].join(' ')).not.toContain('.env');
  expect(args[1].join(' ')).not.toContain(TOKEN);
  expect(cleanup.run).toHaveBeenCalledWith(
    'docker',
    ['rm', '-f', expect.stringMatching(/^pi-wedge-tool-/)],
    '/tmp/isolated-data/tmp/job',
  );
});
it('removes the daemon container even if the Docker CLI times out', async () => {
  const runner = {
      run: vi.fn().mockRejectedValue(new CommandError('command_timeout', 'timeout', '')),
    },
    cleanup = { run: vi.fn(async () => ({ stdout: '', stderr: '' })) };
  await expect(
    new DockerCommandRunner(runner, config, cleanup).run('python3', [], '/tmp/isolated-data'),
  ).rejects.toMatchObject({ code: 'command_timeout' });
  expect(cleanup.run).toHaveBeenCalledOnce();
});
it('recovers only containers labelled with the current data directory', async () => {
  const cleanup = {
    run: vi.fn(async (_command: string, args: string[]) => ({
      stdout: args[0] === 'ps' ? 'abc123def456\n' : '',
      stderr: '',
    })),
  };
  await new DockerCommandRunner(cleanup, config, cleanup).recover();
  expect(cleanup.run).toHaveBeenNthCalledWith(
    1,
    'docker',
    ['ps', '-aq', '--filter', 'label=pi_wedge.data_dir=/tmp/isolated-data'],
    '/tmp/isolated-data',
  );
  expect(cleanup.run).toHaveBeenNthCalledWith(
    2,
    'docker',
    ['rm', '-f', 'abc123def456'],
    '/tmp/isolated-data',
  );
});

it('refuses recovery when an owned stale container cannot be removed', async () => {
  const cleanup = {
    run: vi.fn(async (_command: string, args: string[]) => {
      if (args[0] === 'ps') return { stdout: 'abc123def456', stderr: '' };
      throw new CommandError('command_failed', 'unavailable', 'Daemon unavailable');
    }),
  };
  await expect(new DockerCommandRunner(cleanup, config, cleanup).recover()).rejects.toMatchObject({
    code: 'tool_cleanup_failed',
    status: 503,
  });
});
