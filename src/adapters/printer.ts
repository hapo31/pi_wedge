import { Client as FtpClient } from 'basic-ftp';
import { connectAsync } from 'mqtt';
import type { MqttClient } from 'mqtt';
import { readFile } from 'node:fs/promises';
import type { PeerCertificate } from 'node:tls';
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
  async stopPrint(_id: string): Promise<void> {
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
      // Bambu's printer certificate identifies the device by serial in its CN,
      // not by the LAN hostname/IP. The CA chain is still verified above.
      ...(!this.config.PRINTER_INSECURE_TLS
        ? {
            checkServerIdentity: (_hostname: string, cert: PeerCertificate) =>
              cert.subject?.CN === this.config.PRINTER_SERIAL ||
              (Array.isArray(cert.subject?.CN) &&
                cert.subject.CN.includes(this.config.PRINTER_SERIAL))
                ? undefined
                : new Error('Printer certificate serial mismatch'),
          }
        : {}),
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
    return this.dispatchCommand(
      operationId,
      'project_file',
      {
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
      true,
    );
  }
  async stopPrint(operationId: string) {
    return this.dispatchCommand(operationId, 'stop', { param: '' }, false);
  }
  private async dispatchCommand(
    operationId: string,
    commandName: 'project_file' | 'stop',
    params: Record<string, unknown>,
    requireIdle: boolean,
  ) {
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
      if (requireIdle) {
        const state = await this.exchange(
          client,
          requestTopic,
          reportTopic,
          operationId,
          { pushing: { sequence_id: '0', command: 'pushall' } },
          (p) => (typeof p.gcode_state === 'string' ? p.gcode_state : null),
        );
        if (!['IDLE', 'FINISH', 'FAILED'].includes(String(state)))
          throw new AppError('printer_busy', 'Printer is not idle', 409);
      }
      const sequence = String(parseInt(operationId.replaceAll('-', '').slice(0, 7), 16));
      const command = {
        print: {
          sequence_id: sequence,
          command: commandName,
          ...params,
        },
      };
      dispatched = true;
      const acknowledgement = await this.exchange(
        client,
        requestTopic,
        reportTopic,
        operationId,
        command,
        (p) =>
          String(p.sequence_id) === sequence &&
          (p.command === commandName ||
            (p.command === undefined &&
              (typeof p.result === 'string' || typeof p.err_code === 'number')))
            ? p
            : null,
      );
      const ack = acknowledgement as Record<string, unknown>;
      const result = typeof ack.result === 'string' ? ack.result.toLowerCase() : '';
      if (
        result === 'fail' ||
        result === 'failed' ||
        (typeof ack.err_code === 'number' && ack.err_code !== 0)
      )
        throw new AppError('printer_rejected', 'Printer rejected the command', 502);
      if (result === 'success') return;
      throw new AppError(
        'printer_outcome_unknown',
        'Printer response did not confirm command acceptance. Check the printer before retrying.',
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
          ? 'Printer command outcome is unknown. Check the printer before retrying.'
          : 'MQTT connection or idle-state check failed',
        dispatched ? 504 : 502,
      );
    } finally {
      await client?.endAsync(true).catch(() => {});
    }
  }
  private diagnosticPayload(payload: Record<string, unknown>) {
    // Allow only protocol fields needed for this exchange. Never log transport
    // credentials, device topics, full telemetry, or arbitrary nested values.
    const fields = [
      'sequence_id',
      'command',
      'param',
      'url',
      'subtask_name',
      'bed_type',
      'bed_leveling',
      'flow_cali',
      'vibration_cali',
      'timelapse',
      'use_ams',
      'ams_mapping',
      'project_id',
      'profile_id',
      'task_id',
      'subtask_id',
      'result',
      'reason',
      'err_code',
      'error_code',
      'gcode_state',
      'print_error',
      'gcode_file_prepare_percent',
      'stg_cur',
      'mc_percent',
      'nozzle_target',
      'bed_target',
    ];
    return Object.fromEntries(
      fields.flatMap<[string, unknown]>((key) => {
        const value = payload[key];
        if (typeof value === 'string') {
          let safe = value;
          for (const secret of [
            this.config.API_TOKEN,
            this.config.PRINTER_ACCESS_CODE,
            this.config.PRINTER_SERIAL,
            this.config.PRINTER_HOST,
            this.config.S3_ACCESS_KEY,
            this.config.S3_SECRET_KEY,
          ])
            if (secret) safe = safe.replaceAll(secret, '[redacted]');
          // Do not expose credentials in URLs or arbitrary response strings.
          safe = safe.replace(/([a-z]+:\/\/)[^\s/]*@/gi, '$1[redacted]@');
          return [[key, safe.slice(0, 256)]];
        }
        if (typeof value === 'number' || typeof value === 'boolean' || value === null)
          return [[key, value]];
        if (key === 'ams_mapping' && Array.isArray(value))
          return [[key, value.filter((v) => typeof v === 'number').slice(0, 8)]];
        return [];
      }),
    );
  }
  private exchange(
    client: MqttClient,
    requestTopic: string,
    reportTopic: string,
    operationId: string,
    payload: { print?: Record<string, unknown>; pushing?: Record<string, unknown> },
    match: (print: Record<string, unknown>) => unknown,
  ) {
    return new Promise<unknown>((resolve, reject) => {
      const started = Date.now();
      const request = payload.print ?? payload.pushing ?? {};
      let settled = false,
        responseCount = 0;
      const log = (event: string, detail: Record<string, unknown> = {}) =>
        console.info(
          JSON.stringify({
            event,
            timestamp: new Date().toISOString(),
            operationId,
            requestCommand: request.command,
            requestSequence: request.sequence_id,
            elapsedMs: Date.now() - started,
            ...detail,
          }),
        );
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        client.off('message', message);
        client.off('error', transportError);
        client.off('close', connectionClosed);
      };
      const failed = (
        cause: 'timeout' | 'transport_error' | 'connection_closed' | 'publish_failed',
      ) => {
        if (settled) return;
        log('printer_mqtt_exchange_failed', { cause, responseCount });
        cleanup();
        reject(new Error('MQTT exchange failed'));
      };
      const transportError = () => failed('transport_error');
      const connectionClosed = () => failed('connection_closed');
      const message = (topic: string, buffer: Buffer) => {
        if (topic !== reportTopic || buffer.length > 65536) return;
        try {
          const parsed = JSON.parse(buffer.toString()) as { print?: Record<string, unknown> };
          if (parsed?.print && typeof parsed.print === 'object' && !Array.isArray(parsed.print)) {
            const value = match(parsed.print);
            responseCount++;
            if (responseCount <= 32 || (value !== null && value !== undefined))
              log('printer_mqtt_response', {
                matched: value !== null && value !== undefined,
                payload: { print: this.diagnosticPayload(parsed.print) },
              });
            if (value !== null && value !== undefined) {
              log('printer_mqtt_exchange_completed', { responseCount });
              cleanup();
              resolve(value);
            }
          }
        } catch {
          /* Ignore unrelated/malformed telemetry. */
        }
      };
      const timer = setTimeout(() => failed('timeout'), this.config.PRINTER_TIMEOUT_MS);
      client.on('message', message);
      client.once('error', transportError);
      client.once('close', connectionClosed);
      log('printer_mqtt_request', {
        payload: { [payload.print ? 'print' : 'pushing']: this.diagnosticPayload(request) },
      });
      void client
        .publishAsync(requestTopic, JSON.stringify(payload), { qos: 1, retain: false })
        .then(() => log('printer_mqtt_published'))
        .catch(() => failed('publish_failed'));
    });
  }
}
