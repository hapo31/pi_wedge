import { errorMessage } from './api.js';
import { usePreviewLayout } from './App.js';

export function PreviewPlaceholder({ error }: { error?: unknown }) {
  const { sidebarHeight } = usePreviewLayout();
  return (
    <>
      <div className="model-area">
        <div className="empty-view">
          <span className="empty-icon">◈</span>
          <h1>プレビュー</h1>
          {error ? (
            <p className="error" role="alert">
              {errorMessage(error)}
            </p>
          ) : (
            <p role="status">読み込み中…</p>
          )}
        </div>
      </div>
      <aside className="sidebar" style={{ minHeight: `max(100%, ${sidebarHeight}px)` }}>
        <h2>{error ? '—' : '読み込み中…'}</h2>
        <div className="stats">
          <div>
            <span>推定時間</span>
            <strong>未取得</strong>
          </div>
          <div>
            <span>フィラメント</span>
            <strong>未取得</strong>
          </div>
        </div>
        <div className="machine-card">
          <span>プリンター</span>
          <strong>Bambu Lab A1 mini</strong>
          <small>0.4 mm ノズル · 180 mm プレート</small>
        </div>
        <div className="print-panel">
          <button className="print-button" disabled>
            印刷
          </button>
        </div>
      </aside>
    </>
  );
}
