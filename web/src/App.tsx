import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getRouteApi, Link, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import type { PreviewData } from './api.js';
import { PlateThumbnails } from './PlateThumbnails.js';

const previewRoute = getRouteApi('/preview/$plateId');
const LayoutContext = createContext<{
  updatePreview: (data: PreviewData) => void;
  setPrintBusy: (busy: boolean) => void;
  sidebarHeight: number;
  reserveSidebarHeight: (height: number) => void;
} | null>(null);

export function usePreviewLayout() {
  const context = useContext(LayoutContext);
  if (!context) throw new Error('Preview layout is required');
  return context;
}

// The parent route survives changes to $previewId. The child owns the selected
// toolpath/print state; this layout owns the list, blob URLs and scroll position.
export function App() {
  const { plateId } = previewRoute.useParams();
  const { previewId = '' } = useParams({ strict: false });
  const navigate = useNavigate();
  const [data, setData] = useState<PreviewData | null>(null);
  const [printBusy, setPrintBusy] = useState(false);
  const [sidebarHeight, setSidebarHeight] = useState(0);
  const updatePreview = useCallback((next: PreviewData) => setData(next), []);
  // Preserve the document's scroll range while the next child has fewer details.
  // This measured minimum resets with the parent route when plateId changes.
  const reserveSidebarHeight = useCallback((height: number) => {
    setSidebarHeight((current) => Math.max(current, Math.ceil(height)));
  }, []);
  const context = useMemo(
    () => ({ updatePreview, setPrintBusy, sidebarHeight, reserveSidebarHeight }),
    [updatePreview, sidebarHeight, reserveSidebarHeight],
  );
  // Keep a single list instance even while the next plate's GET fails or waits.
  const plates = data?.plates ?? [];
  useEffect(() => {
    document.title = 'pi_wedge — プレビュー';
  }, []);
  return (
    <LayoutContext value={context}>
      <div className="app-shell">
        <header className="app-header">
          <span className="brand">
            <span className="brand-symbol">◈</span> pi_wedge
          </span>
          <span className="header-tag">プレビュー</span>
          <Link className="header-link" to="/history">
            履歴
          </Link>
          <div className="connection">
            <span className={data?.printerEnabled ? 'dot active' : 'dot'} />
            {data?.printerEnabled ? 'プリンター設定済み' : 'プリンター未設定'}
          </div>
        </header>
        <main className={`workspace${plates.length > 1 ? ' has-plates' : ''}`}>
          <Outlet />
          {plates.length > 1 && (
            <PlateThumbnails
              uuid={data?.plateId ?? plateId}
              plates={plates}
              selected={previewId || data?.previewId || ''}
              disabled={printBusy}
              onSelect={(id) => {
                void navigate({
                  to: '/preview/$plateId/$previewId',
                  params: { plateId: data?.plateId ?? plateId, previewId: id },
                  resetScroll: false,
                });
              }}
            />
          )}
        </main>
      </div>
    </LayoutContext>
  );
}
