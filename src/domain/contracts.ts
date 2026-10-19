import type { Readable } from 'node:stream';
import type { FileMetadata, PrintOptions, SliceOptions, PrinterStatus } from './schemas.js';
export interface ObjectStorage {
  put(id: string, body: Readable, size: number): Promise<void>;
  get(id: string): Promise<Readable>;
  head(id: string): Promise<{ size: number } | null>;
  delete(id: string): Promise<void>;
  check(): Promise<void>;
}
export interface ModelFile {
  id: string;
  path: string;
  format: 'stl' | 'step';
  workDir: string;
}
export interface SliceResult {
  path: string;
  format: 'gcode' | 'gcode.3mf';
  estimatedSeconds: number | null;
  filamentGrams: number | null;
  filamentMillimeters: number | null;
}
export interface Slicer {
  slice(input: ModelFile, options: SliceOptions): Promise<SliceResult>;
}
export interface ModelConverter {
  convert(input: ModelFile, options: SliceOptions['mesh']): Promise<ModelFile>;
}
export interface Printer {
  readStatus(): Promise<PrinterStatus>;
  upload(file: FileMetadata, path: string): Promise<{ remotePath: string }>;
  startPrint(remotePath: string, options: PrintOptions, operationId: string): Promise<void>;
  stopPrint(operationId: string): Promise<void>;
}
