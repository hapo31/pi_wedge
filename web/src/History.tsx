import { useEffect, useState } from 'react';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { errorMessage } from './api.js';
import { historyOptions, validateHistorySearch } from './query-options.js';

function duration(seconds: number | null) {
  if (seconds === null) return '—';
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}時間${minutes % 60}分` : `${minutes}分`;
}

export function History() {
  const { q = '' } = getRouteApi('/history').useSearch();
  const navigate = useNavigate();
  const [searchText, setSearchText] = useState(q);
  const [searchError, setSearchError] = useState('');
  const result = useInfiniteQuery(historyOptions(q));
  const items = result.data?.pages.flatMap((page) => page.items) ?? [];
  const loading = result.isFetching;
  const error = searchError || (result.error ? errorMessage(result.error) : '');
  useEffect(() => {
    document.title = 'pi_wedge — スライス履歴';
  }, []);
  return (
    <div className="app-shell">
      <header className="app-header">
        <Link className="brand" to="/history">
          <span className="brand-symbol">◈</span> pi_wedge
        </Link>
        <span className="header-tag">スライス履歴</span>
      </header>
      <main className="history-main">
        <h1>スライス履歴</h1>
        <form
          className="history-search"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              const search = validateHistorySearch({ q: searchText });
              setSearchError('');
              void navigate({ to: '/history', search });
            } catch (cause) {
              setSearchError(errorMessage(cause));
            }
          }}
        >
          <input
            aria-label="履歴を検索"
            placeholder="名前・元ファイル名"
            value={searchText}
            maxLength={80}
            onChange={(event) => setSearchText(event.target.value)}
          />
          <button type="submit">検索</button>
        </form>
        {items.length > 0 && (
          <div className="history-list">
            {items.map((item) => (
              <Link
                className="history-row"
                to={
                  item.plateId && item.previewId
                    ? '/preview/$plateId/$previewId'
                    : '/preview/$plateId'
                }
                params={{ plateId: item.plateId ?? item.id, previewId: item.previewId ?? '' }}
                // Short/legacy URLs use Hono's canonical UUID redirect.
                reloadDocument={!item.plateId || !item.previewId}
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
              </Link>
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
          <p>{q ? '見つかりません。' : 'スライスはまだありません。'}</p>
        )}
        {result.hasNextPage && !loading && (
          <button
            className="secondary history-more"
            onClick={() => {
              if (!result.isFetching) void result.fetchNextPage();
            }}
          >
            さらに表示
          </button>
        )}
      </main>
    </div>
  );
}
