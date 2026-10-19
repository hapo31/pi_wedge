import { PrinterStatusSchema } from '../domain/schemas.js';
import type { PrinterStatus } from '../domain/schemas.js';
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function integer(value: unknown): number | null {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : null;
}
/** Only expose AMS Lite slot data; identifiers, RFID and transport details stay private. */
export function parsePrinterStatus(print: Record<string, unknown>): PrinterStatus {
  const ams = object(print.ams),
    units = Array.isArray(ams.ams) ? ams.ams : [];
  const unit = units.map(object).find((u) => integer(u.id) === 0);
  const exists = integer(ams.ams_exist_bits),
    occupied = integer(ams.tray_exist_bits);
  const connected = exists !== null ? (exists & 1) !== 0 : unit ? true : null;
  const now = integer(ams.tray_now),
    currentSlot = now !== null && now <= 3 ? now : null;
  const trays = Array.isArray(unit?.tray) ? unit.tray.map(object) : [];
  const slots =
    connected === true
      ? Array.from({ length: 4 }, (_, slot) => {
          const tray = trays.find((t) => integer(t.id) === slot) ?? {};
          const rawColor = text(tray.tray_color),
            remain = integer(tray.remain);
          return {
            slot,
            present: occupied !== null ? (occupied & (1 << slot)) !== 0 : null,
            material: text(tray.tray_type),
            color:
              rawColor && /^[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(rawColor)
                ? `#${rawColor.slice(0, 6).toUpperCase()}`
                : null,
            remainingPercent: remain !== null && remain <= 100 ? remain : null,
            active: currentSlot === slot,
          };
        })
      : [];
  return PrinterStatusSchema.parse({
    observedAt: new Date().toISOString(),
    gcodeState: text(print.gcode_state),
    amsConnected: connected,
    currentSlot,
    externalSpoolActive: now === null ? null : now === 254,
    slots,
  });
}
