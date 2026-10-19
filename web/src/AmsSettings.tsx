import type { PrinterStatus } from './api.js';
export function AmsSettings({
  status,
  loading,
  error,
  selected,
  disabled,
  onSelect,
  onRefresh,
}: {
  status: PrinterStatus | null;
  loading: boolean;
  error: string;
  selected: number | null;
  disabled: boolean;
  onSelect: (slot: number | null) => void;
  onRefresh: () => void;
}) {
  const available =
    status?.slots.filter(
      (s) => s.present === true && (!s.material || s.material.toUpperCase() === 'PLA'),
    ) ?? [];
  return (
    <section className="ams-panel" aria-label="AMS設定">
      <div className="ams-heading">
        <strong>フィラメント供給</strong>
        <button type="button" className="secondary" onClick={onRefresh} disabled={loading}>
          {loading ? '取得中…' : '更新'}
        </button>
      </div>
      {error ? (
        <p className="ams-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="ams-state">
          {!status
            ? '状態未取得'
            : status.amsConnected === true
              ? 'AMS Lite 接続済み'
              : status.amsConnected === false
                ? 'AMS未接続'
                : 'AMS接続状態不明'}
          {status && (
            <span>
              {' '}
              ·{' '}
              {new Date(status.observedAt).toLocaleTimeString('ja-JP', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
            </span>
          )}
        </p>
      )}
      {status && (
        <p className="ams-state">
          現在:{' '}
          {status.externalSpoolActive === true
            ? '外部スプール'
            : status.currentSlot !== null
              ? `AMS スロット${status.currentSlot + 1}`
              : '供給元未取得'}
        </p>
      )}
      <div className="supply-options">
        <label>
          <input
            type="radio"
            name="supply"
            checked={selected === null}
            onChange={() => onSelect(null)}
            disabled={disabled}
          />
          外部スプール
        </label>
        <label>
          <input
            type="radio"
            name="supply"
            checked={selected !== null}
            onChange={() => onSelect(available[0]?.slot ?? null)}
            disabled={disabled || !available.length}
          />
          AMS Lite
        </label>
      </div>
      {status?.amsConnected === true && (
        <div className="ams-slots">
          {status.slots.map((s) => (
            <button
              type="button"
              className={`ams-slot ${selected === s.slot ? 'selected' : ''}`}
              key={s.slot}
              aria-label={`AMS スロット${s.slot + 1}`}
              aria-pressed={selected === s.slot}
              disabled={
                disabled ||
                s.present !== true ||
                Boolean(s.material && s.material.toUpperCase() !== 'PLA')
              }
              onClick={() => onSelect(s.slot)}
            >
              <span className="slot-title">
                {s.slot + 1}
                <span
                  className="color-swatch"
                  style={{ backgroundColor: s.color ?? '#526373' }}
                  aria-label={s.color ?? '色未取得'}
                />
              </span>
              <strong>
                {s.present === false
                  ? '空'
                  : s.present === null
                    ? '未取得'
                    : (s.material ?? '材料未取得')}
              </strong>
              <small>{s.present === true ? (s.color ?? '色未取得') : '—'}</small>
              {s.active && <small className="slot-active">使用中</small>}
            </button>
          ))}
        </div>
      )}
      <p className="ams-state">スライス設定: Generic PLA</p>
    </section>
  );
}
