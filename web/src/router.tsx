import { createRootRoute, createRoute, createRouter, Link } from '@tanstack/react-router';
import { App } from './App.js';
import { History } from './History.js';
import { PreviewScreen } from './PreviewScreen.js';
import { PreviewPlaceholder } from './PreviewPlaceholder.js';
import { loadQuery, queryClient } from './query-client.js';
import { previewDataOptions, validateHistorySearch, validateSelection } from './query-options.js';
import { errorMessage } from './api.js';

const rootRoute = createRootRoute({
  errorComponent: ({ error }) => (
    <div className="empty-view">
      <p className="error" role="alert">
        {errorMessage(error)}
      </p>
      <Link to="/history" search={{}}>
        履歴
      </Link>
    </div>
  ),
  notFoundComponent: () => (
    <div className="empty-view">
      <p className="error" role="alert">
        プレビューのURLを確認してください。
      </p>
      <Link to="/history">履歴</Link>
    </div>
  ),
});
const historyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/history',
  validateSearch: validateHistorySearch,
  remountDeps: ({ search }) => search.q ?? '',
  component: History,
});
const previewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/preview/$plateId',
  // A different set must clear its list; changing only the child must retain it.
  remountDeps: ({ params }) => params.plateId,
  component: App,
});
const selectionLoader = {
  staleReloadMode: 'blocking' as const,
  handler: async ({
    params,
    abortController,
  }: {
    params: { plateId: string; previewId?: string };
    abortController: AbortController;
  }) => {
    validateSelection(params.plateId, params.previewId);
    await loadQuery(
      queryClient,
      previewDataOptions(params.plateId, params.previewId),
      abortController.signal,
    );
  },
};
const selectionComponents = {
  pendingComponent: PreviewPlaceholder,
  errorComponent: ({ error }: { error: unknown }) => <PreviewPlaceholder error={error} />,
  pendingMs: 0,
  pendingMinMs: 0,
  staleTime: 0,
  gcTime: 0,
};
const previewIndexRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: '/',
  loader: selectionLoader,
  ...selectionComponents,
  component: PreviewScreen,
});
const selectedPreviewRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: '$previewId',
  loader: selectionLoader,
  ...selectionComponents,
  // Reset Viewer, AMS selection and PrintController together for each UUID.
  remountDeps: ({ params }) => params.previewId,
  component: PreviewScreen,
});

const routeTree = rootRoute.addChildren([
  historyRoute,
  previewRoute.addChildren([previewIndexRoute, selectedPreviewRoute]),
]);

export const router = createRouter({ routeTree, defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
