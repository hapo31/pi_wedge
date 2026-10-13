import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FileMetadata, PrintOperation, SliceJob } from '../domain/schemas.js';
type Records = {
  file: FileMetadata;
  job: SliceJob & { reservedResultId: string };
  operation: PrintOperation;
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
