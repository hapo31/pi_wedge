import { useEffect, useState } from 'react';
import { errorMessage, fetchPreview } from './api.js';
import type { HistoryItem, HistoryPage } from './api.js';

function duration(seconds: number | null) {
  if (seconds === null) return '—';
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}時間${minutes % 60}分` : `${minutes}分`;
}

export function History() {
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError('');
    setItems([]);
    setCursor(null);
    void (async () => {
      try {
        const page = (await (
          await fetchPreview(
            query ? `/history/data?q=${encodeURIComponent(query)}` : '/history/data',
            { signal: abort.signal },
          )
        ).json()) as HistoryPage;
        if (abort.signal.aborted) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      } catch (cause) {
        if (!abort.signal.aborted) setError(errorMessage(cause));
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    })();
    return () => abort.abort();
  }, [query]);
  async function more() {
    if (!cursor || loading) return;
    setLoading(true);
    setError('');
    try {
      const page = (await (
        await fetchPreview(
          `/history/data?cursor=${encodeURIComponent(cursor)}${query ? `&q=${encodeURIComponent(query)}` : ''}`,
        )
      ).json()) as HistoryPage;
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="/history">
          <span className="brand-symbol">◈</span> pi_wedge
        </a>
        <span className="header-tag">スライス履歴</span>
      </header>
      <main className="history-main">
        <h1>スライス履歴</h1>
        <form
          className="history-search"
          onSubmit={(event) => {
            event.preventDefault();
            if (!loading) setQuery(searchText.trim());
          }}
        >
          <input
            aria-label="履歴を検索"
            placeholder="名前・元ファイル名"
            value={searchText}
            maxLength={80}
            onChange={(event) => setSearchText(event.target.value)}
          />
          <button type="submit" disabled={loading}>
            検索
          </button>
        </form>
        {items.length > 0 && (
          <div className="history-list">
            {items.map((item) => (
              <a
                className="history-row"
                href={
                  item.plateId
                    ? `/preview/${item.plateId}/${item.previewId}`
                    : `/preview/${item.id}`
                }
                key={item.id}
              >
                <span className="history-name">
                  {item.name}
                  {item.plateCount && item.plateCount > 1 ? (
                    <small className="history-plates">{item.plateCount}枚</small>
                  ) : null}
                </span>
                <time dateTime={item.createdAt}>
                  {new Date(item.createdAt).toLocaleString('ja-JP', {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                </time>
                <span>{duration(item.estimatedSeconds)}</span>
                <span>
                  {item.filamentGrams === null ? '—' : `${item.filamentGrams.toFixed(1)} g`}
                </span>
                <span className="history-arrow" aria-hidden="true">
                  →
                </span>
              </a>
            ))}
          </div>
        )}
        {loading && <p role="status">読み込み中…</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && items.length === 0 && (
          <p>{query ? '見つかりません。' : 'スライスはまだありません。'}</p>
        )}
        {cursor && !loading && (
          <button className="secondary history-more" onClick={() => void more()}>
            さらに表示
          </button>
        )}
      </main>
    </div>
  );
}
