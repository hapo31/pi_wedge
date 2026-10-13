import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Client as FtpClient } from 'basic-ftp';
import { ProcessRunner } from '../src/adapters/command.js';
import { BambuLanPrinter } from '../src/adapters/printer.js';
import type { MqttConnector } from '../src/adapters/printer.js';
import { readConfig } from '../src/config.js';
import { PrintOptionsSchema } from '../src/domain/schemas.js';
import { openGcode, inspectGcode } from '../src/adapters/gcode.js';
import { OrcaSlicerAdapter } from '../src/adapters/orca.js';
import { FreeCadConverter } from '../src/adapters/converter.js';
import { GCODE, storedZip, TOKEN } from './helpers.js';
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function temp() {
  const d = await mkdtemp(join(tmpdir(), 'pi-wedge-adapter-'));
  dirs.push(d);
  return d;
}
describe('external command runner', () => {
  it('passes shell metacharacters literally and bounds logs', async () => {
    const dir = await temp(),
      r = await new ProcessRunner(1000, 64).run(
        process.execPath,
        [
          '-e',
          'console.log(process.argv[1]);console.error("x".repeat(1000))',
          '$(touch should-not-exist)',
        ],
        dir,
      );
    expect(r.stdout).toContain('$(touch should-not-exist)');
    expect(Buffer.byteLength(r.stderr)).toBeLessThanOrEqual(64);
  });
  it('detects abnormal exits, timeout, unavailable executables and hides secrets from child env', async () => {
    const dir = await temp(),
      runner = new ProcessRunner(100);
    await expect(
      runner.run(process.execPath, ['-e', 'process.exit(3)'], dir),
    ).rejects.toMatchObject({ code: 'command_failed' });
    await expect(
      runner.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], dir),
    ).rejects.toMatchObject({ code: 'command_timeout' });
    await expect(runner.run('/nonexistent/tool', [], dir)).rejects.toMatchObject({
      code: 'command_unavailable',
    });
    process.env.PRINTER_ACCESS_CODE = 'test-secret';
    expect(
      (
        await runner.run(
          process.execPath,
          ['-e', 'console.log(process.env.PRINTER_ACCESS_CODE)'],
          dir,
        )
      ).stdout.trim(),
    ).toBe('undefined');
    delete process.env.PRINTER_ACCESS_CODE;
  });
});
describe('Orca and FreeCAD boundaries (fake runner, no hardware claim)', () => {
  it('uses flattened profile files, bounded options and verifies the real container structure', async () => {
    const dir = await temp();
    await writeFile(
      join(dir, 'machine.json'),
      JSON.stringify({ printer_model: 'Bambu Lab A1 mini', nozzle_diameter: ['0.4'] }),
    );
    await writeFile(join(dir, 'process.json'), '{}');
    await writeFile(join(dir, 'filament.json'), '{}');
    const runner = {
      run: vi.fn(async (_cmd: string, args: string[]) => {
        const path = args[args.indexOf('--export-3mf') + 1]!;
        await writeFile(path, storedZip('Metadata/plate_1.gcode', Buffer.from(GCODE)));
        return { stdout: '', stderr: '' };
      }),
    };
    const config = readConfig({
      API_TOKEN: TOKEN,
      STORAGE_BACKEND: 'local',
      PROFILE_DIR: dir,
      ORCA_BIN: '/trusted/orca',
    });
    const result = await new OrcaSlicerAdapter(runner, config).slice(
      { id: randomUUID(), path: join(dir, 'model.stl'), format: 'stl', workDir: dir },
      (await import('../src/domain/schemas.js')).SliceOptionsSchema.parse({ infillDensity: 25 }),
    );
    expect(result.estimatedSeconds).toBe(62);
    expect(result.format).toBe('gcode.3mf');
    expect(runner.run).toHaveBeenCalledWith(
      '/trusted/orca',
      expect.arrayContaining(['--slice', '1', '--load-settings', '--load-filaments']),
      dir,
    );
  });
  it('keeps STEP meshing options and module configuration out of shell expansion', async () => {
    const dir = await temp(),
      runner = {
        run: vi.fn(async () => {
          await writeFile(join(dir, 'converted.stl'), 'mesh');
          return { stdout: '', stderr: '' };
        }),
      };
    const converter = new FreeCadConverter(
      runner,
      '/usr/bin/python3',
      '/usr/lib/freecad/lib',
      1000,
    );
    const result = await converter.convert(
      { id: randomUUID(), path: join(dir, 'input.step'), workDir: dir, format: 'step' },
      { linearDeflection: 0.2, angularDeflection: 0.5 },
    );
    expect(result.format).toBe('stl');
    expect(runner.run).toHaveBeenCalledWith('/usr/bin/python3', expect.any(Array), dir, {
      PI_WEDGE_CONVERSION_CONFIG: join(dir, 'conversion.json'),
    });
  });
});
class MockMqtt extends EventEmitter {
  published: Array<Record<string, unknown>> = [];
  subscribeAsync = vi.fn(async () => []);
  endAsync = vi.fn(async () => {});
  constructor(private mode: 'success' | 'busy' | 'reject' | 'timeout' = 'success') {
    super();
  }
  async publishAsync(_topic: string, text: string) {
    const payload = JSON.parse(text);
    this.published.push(payload);
    queueMicrotask(() => {
      if (payload.pushing)
        this.emit(
          'message',
          'device/SERIAL/report',
          Buffer.from(
            JSON.stringify({ print: { gcode_state: this.mode === 'busy' ? 'RUNNING' : 'IDLE' } }),
          ),
        );
      else if (this.mode !== 'timeout')
        this.emit(
          'message',
          'device/SERIAL/report',
          Buffer.from(
            JSON.stringify({
              print: {
                command: 'project_file',
                sequence_id: payload.print.sequence_id,
                result: this.mode === 'reject' ? 'fail' : 'success',
              },
            }),
          ),
        );
    });
    return undefined;
  }
}
describe('Bambu TLS/MQTT/FTPS transport mocks', () => {
  const options = PrintOptionsSchema.parse({});
  function printer(mode: ConstructorParameters<typeof MockMqtt>[0] = 'success') {
    const client = new MockMqtt(mode),
      config = readConfig({
        API_TOKEN: TOKEN,
        STORAGE_BACKEND: 'local',
        PRINTER_HOST: '192.168.1.2',
        PRINTER_SERIAL: 'SERIAL',
        PRINTER_ACCESS_CODE: 'secret',
        PRINTER_TIMEOUT_MS: '1000',
      }),
      connector = vi.fn(async () => client) as unknown as MqttConnector;
    return { client, connector, adapter: new BambuLanPrinter(config, connector) };
  }
  it('subscribes before publishing, checks idle, sets print options, waits for matching ACK and closes', async () => {
    const p = printer();
    await p.adapter.startPrint('/uuid.gcode.3mf', options, randomUUID());
    expect(p.client.subscribeAsync).toHaveBeenCalledWith('device/SERIAL/report', { qos: 1 });
    expect(p.client.published[1]).toMatchObject({
      print: {
        command: 'project_file',
        url: 'ftp:///uuid.gcode.3mf',
        param: 'Metadata/plate_1.gcode',
        bed_leveling: true,
        use_ams: false,
      },
    });
    expect(p.connector).toHaveBeenCalledWith(
      'mqtts://192.168.1.2:8883',
      expect.objectContaining({ rejectUnauthorized: true, reconnectPeriod: 0 }),
    );
    expect(p.client.endAsync).toHaveBeenCalledOnce();
  });
  it('rejects busy, records definite rejection and treats lost ACK as unknown', async () => {
    const busy = printer('busy');
    await expect(busy.adapter.startPrint('/x', options, randomUUID())).rejects.toMatchObject({
      code: 'printer_busy',
    });
    expect(busy.client.published).toHaveLength(1);
    await expect(
      printer('reject').adapter.startPrint('/x', options, randomUUID()),
    ).rejects.toMatchObject({ code: 'printer_rejected' });
    await expect(
      printer('timeout').adapter.startPrint('/x', options, randomUUID()),
    ).rejects.toMatchObject({ code: 'printer_outcome_unknown', status: 504 });
  });
  it('uses implicit FTPS 990, private TLS and remote-size verification', async () => {
    const config = readConfig({
        API_TOKEN: TOKEN,
        STORAGE_BACKEND: 'local',
        PRINTER_HOST: '192.168.1.2',
        PRINTER_ACCESS_CODE: 'secret',
      }),
      ftp = {
        access: vi.fn(async () => {}),
        uploadFrom: vi.fn(async () => {}),
        size: vi.fn(async () => 12),
        close: vi.fn(),
      },
      adapter = new BambuLanPrinter(config, undefined, () => ftp as unknown as FtpClient);
    await adapter.upload({ id: randomUUID(), size: 12 } as never, '/tmp/test.3mf');
    expect(ftp.access).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 990,
        secure: 'implicit',
        secureOptions: { rejectUnauthorized: true },
      }),
    );
    expect(ftp.size).toHaveBeenCalledOnce();
    expect(ftp.close).toHaveBeenCalledOnce();
  });
});
describe('G-code container adapter', () => {
  it('extracts the expected plate and statistics from a ZIP', async () => {
    const dir = await temp(),
      path = join(dir, 'result.3mf');
    await writeFile(path, storedZip('Metadata/plate_1.gcode', Buffer.from(GCODE)));
    expect(await inspectGcode(await openGcode(path, 'gcode.3mf', 10000))).toEqual({
      estimatedSeconds: 62,
      filamentGrams: 1.2,
      filamentMillimeters: 340,
    });
  });
  it('rejects malformed archives, missing plate and excessive uncompressed size', async () => {
    const dir = await temp(),
      path = join(dir, 'result.3mf');
    await writeFile(path, 'not a zip');
    await expect(openGcode(path, 'gcode.3mf', 1000)).rejects.toMatchObject({ status: 422 });
    await writeFile(path, storedZip('elsewhere.gcode', Buffer.from(GCODE)));
    await expect(openGcode(path, 'gcode.3mf', 1000)).rejects.toMatchObject({
      code: 'missing_gcode',
    });
    await writeFile(path, storedZip('Metadata/plate_1.gcode', Buffer.from(GCODE)));
    await expect(openGcode(path, 'gcode.3mf', 1)).rejects.toMatchObject({ status: 413 });
  });
});
