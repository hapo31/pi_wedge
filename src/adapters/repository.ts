import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  FileMetadata,
  PrintOperation,
  SliceJob,
  StopPrintOperation,
} from '../domain/schemas.js';
type Records = {
  file: FileMetadata;
  job: SliceJob & { reservedResultId: string };
  operation: PrintOperation;
  stopOperation: StopPrintOperation;
};
export class Repository {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version > 1) throw new Error('Database schema newer than application');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id)); PRAGMA user_version=1;',
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS ready_slices_order ON records(json_extract(payload,'$.createdAt') DESC, id DESC)
       WHERE kind='file' AND json_extract(payload,'$.state')='ready'
       AND json_extract(payload,'$.format') IN ('gcode','gcode.3mf')
       AND json_extract(payload,'$.sourceModelId') IS NOT NULL`,
    );
  }
  get<K extends keyof Records>(kind: K, id: string): Records[K] | null {
    const row = this.db
      .prepare('SELECT payload FROM records WHERE kind=? AND id=?')
      .get(kind, id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Records[K]) : null;
  }
  all<K extends keyof Records>(kind: K): Records[K][] {
    return (
      this.db.prepare('SELECT payload FROM records WHERE kind=? ORDER BY rowid').all(kind) as {
        payload: string;
      }[]
    ).map((r) => JSON.parse(r.payload) as Records[K]);
  }
  readySlices(
    limit: number,
    before?: { id: string; createdAt: string },
    query?: string,
  ): FileMetadata[] {
    const condition = before
      ? "AND (json_extract(f.payload,'$.createdAt') < ? OR (json_extract(f.payload,'$.createdAt') = ? AND f.id < ?))"
      : '';
    const search = query
      ? "AND (instr(lower(coalesce(json_extract(f.payload,'$.displayName'),'')),lower(?)) > 0 OR instr(lower(coalesce(json_extract(m.payload,'$.name'),'')),lower(?)) > 0)"
      : '';
    const statement = this.db.prepare(
      `SELECT f.payload FROM records f LEFT JOIN records m
       ON m.kind='file' AND m.id=json_extract(f.payload,'$.sourceModelId')
       WHERE f.kind='file' AND json_extract(f.payload,'$.state')='ready'
       AND json_extract(f.payload,'$.format') IN ('gcode','gcode.3mf')
       AND json_extract(f.payload,'$.sourceModelId') IS NOT NULL ${condition} ${search}
       ORDER BY json_extract(f.payload,'$.createdAt') DESC, f.id DESC LIMIT ?`,
    );
    const args: Array<string | number> = [];
    if (before) args.push(before.createdAt, before.createdAt, before.id);
    if (query) args.push(query, query);
    args.push(limit);
    const rows = statement.all(...args) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as FileMetadata);
  }
  save<K extends keyof Records>(kind: K, value: Records[K]) {
    this.db
      .prepare(
        'INSERT INTO records(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload',
      )
      .run(kind, value.id, JSON.stringify(value));
  }
  insert<K extends keyof Records>(kind: K, value: Records[K]) {
    this.db
      .prepare('INSERT INTO records(kind,id,payload) VALUES(?,?,?)')
      .run(kind, value.id, JSON.stringify(value));
  }
  close() {
    this.db.close();
  }
}
