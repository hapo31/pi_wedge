import { Client as FtpClient } from 'basic-ftp';
import { connectAsync } from 'mqtt';
import type { MqttClient } from 'mqtt';
import { readFile } from 'node:fs/promises';
import type { Printer } from '../domain/contracts.js';
import type { FileMetadata, PrintOptions } from '../domain/schemas.js';
import type { Config } from '../config.js';
import { AppError } from '../domain/errors.js';
export class DisabledPrinter implements Printer {
  async upload(_file: FileMetadata, _path: string): Promise<{ remotePath: string }> {
    throw new AppError('printer_disabled', 'Configure and enable the printer before use', 503);
  }
  async startPrint(_remotePath: string, _options: PrintOptions, _id: string): Promise<void> {
    throw new AppError('printer_disabled', 'Configure and enable the printer before use', 503);
  }
}
export type MqttConnector = typeof connectAsync;
export class BambuLanPrinter implements Printer {
  constructor(
    private config: Config,
    private connector: MqttConnector = connectAsync,
    private ftpFactory: () => FtpClient = () => new FtpClient(config.PRINTER_TIMEOUT_MS),
  ) {}
  private async tlsOptions() {
    return {
      rejectUnauthorized: !this.config.PRINTER_INSECURE_TLS,
      ...(this.config.PRINTER_CA_FILE ? { ca: await readFile(this.config.PRINTER_CA_FILE) } : {}),
    };
  }
  async upload(file: FileMetadata, path: string) {
    const remotePath = `/${file.id}.gcode.3mf`,
      ftp = this.ftpFactory();
    try {
      await ftp.access({
        host: this.config.PRINTER_HOST,
        port: 990,
        user: 'bblp',
        password: this.config.PRINTER_ACCESS_CODE,
        secure: 'implicit',
        secureOptions: await this.tlsOptions(),
      });
      await ftp.uploadFrom(path, remotePath);
      if ((await ftp.size(remotePath)) !== file.size) throw new Error('size mismatch');
      return { remotePath };
    } catch {
      throw new AppError(
        'printer_upload_failed',
        'FTPS upload or remote size verification failed',
        502,
      );
    } finally {
      ftp.close();
    }
  }
  async startPrint(remotePath: string, options: PrintOptions, operationId: string) {
    let client: MqttClient | undefined,
      dispatched = false;
    try {
      client = await this.connector(`mqtts://${this.config.PRINTER_HOST}:8883`, {
        ...(await this.tlsOptions()),
        username: 'bblp',
        password: this.config.PRINTER_ACCESS_CODE,
        reconnectPeriod: 0,
        connectTimeout: this.config.PRINTER_TIMEOUT_MS,
        clientId: `pi_wedge_${operationId.slice(0, 8)}`,
        clean: true,
      });
      // Prevent unhandled late transport errors; each request also has its own listener.
      client.on('error', () => {});
      const requestTopic = `device/${this.config.PRINTER_SERIAL}/request`,
        reportTopic = `device/${this.config.PRINTER_SERIAL}/report`;
      await client.subscribeAsync(reportTopic, { qos: 1 });
      const state = await this.exchange(
        client,
        requestTopic,
        reportTopic,
        { pushing: { sequence_id: '0', command: 'pushall' } },
        (p) => (typeof p.gcode_state === 'string' ? p.gcode_state : null),
      );
      if (!['IDLE', 'FINISH', 'FAILED'].includes(String(state)))
        throw new AppError('printer_busy', 'Printer is not idle', 409);
      const sequence = String(parseInt(operationId.replaceAll('-', '').slice(0, 7), 16));
      const command = {
        print: {
          sequence_id: sequence,
          command: 'project_file',
          param: `Metadata/plate_${options.plate}.gcode`,
          url: `ftp://${remotePath}`,
          subtask_name: operationId,
          bed_type: 'textured_plate',
          bed_leveling: options.bedLeveling,
          flow_cali: options.flowCalibration,
          vibration_cali: options.vibrationCalibration,
          timelapse: options.timelapse,
          use_ams: options.useAms,
          ams_mapping: options.amsMapping ?? [],
          project_id: '0',
          profile_id: '0',
          task_id: '0',
          subtask_id: '0',
        },
      };
      dispatched = true;
      const acknowledgement = await this.exchange(
        client,
        requestTopic,
        reportTopic,
        command,
        (p) => (p.command === 'project_file' && String(p.sequence_id) === sequence ? p : null),
      );
      const ack = acknowledgement as Record<string, unknown>;
      if (ack.result === 'success') return;
      if (ack.result === 'fail' || ack.result === 'failed')
        throw new AppError('printer_rejected', 'Printer rejected the print command', 502);
      throw new AppError(
        'printer_outcome_unknown',
        'Printer response did not confirm acceptance. Check the printer before retrying.',
        504,
      );
    } catch (error) {
      if (
        error instanceof AppError &&
        ['printer_busy', 'printer_rejected', 'printer_outcome_unknown'].includes(error.code)
      )
        throw error;
      throw new AppError(
        dispatched ? 'printer_outcome_unknown' : 'printer_connection_failed',
        dispatched
          ? 'Print command outcome is unknown. Check the printer before retrying.'
          : 'MQTT connection or idle-state check failed',
        dispatched ? 504 : 502,
      );
    } finally {
      await client?.endAsync(true).catch(() => {});
    }
  }
  private exchange(
    client: MqttClient,
    requestTopic: string,
    reportTopic: string,
    payload: unknown,
    match: (print: Record<string, unknown>) => unknown,
  ) {
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        client.off('message', message);
        client.off('error', failed);
        client.off('close', failed);
      };
      const failed = () => {
        cleanup();
        reject(new Error('MQTT exchange failed'));
      };
      const message = (topic: string, buffer: Buffer) => {
        if (topic !== reportTopic || buffer.length > 65536) return;
        try {
          const parsed = JSON.parse(buffer.toString()) as { print?: Record<string, unknown> };
          if (parsed.print) {
            const value = match(parsed.print);
            if (value !== null && value !== undefined) {
              cleanup();
              resolve(value);
            }
          }
        } catch {
          /* Ignore unrelated/malformed telemetry. */
        }
      };
      const timer = setTimeout(failed, this.config.PRINTER_TIMEOUT_MS);
      client.on('message', message);
      client.once('error', failed);
      client.once('close', failed);
      void client
        .publishAsync(requestTopic, JSON.stringify(payload), { qos: 1, retain: false })
        .catch(failed);
    });
  }
}
