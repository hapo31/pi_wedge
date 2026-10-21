import { createRootRoute, createRoute, createRouter, Link } from '@tanstack/react-router';
import { App } from './App.js';
import { History } from './History.js';
import { PreviewScreen } from './PreviewScreen.js';

const rootRoute = createRootRoute({
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
  component: History,
});
const previewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/preview/$plateId',
  // A different set must clear its list; changing only the child must retain it.
  remountDeps: ({ params }) => params.plateId,
  component: App,
});
const previewIndexRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: '/',
  component: PreviewScreen,
});
const selectedPreviewRoute = createRoute({
  getParentRoute: () => previewRoute,
  path: '$previewId',
  // Reset Viewer, AMS selection and PrintController together for each UUID.
  remountDeps: ({ params }) => params.previewId,
  component: PreviewScreen,
});

const routeTree = rootRoute.addChildren([
  historyRoute,
  previewRoute.addChildren([previewIndexRoute, selectedPreviewRoute]),
]);

// Fetches remain in abortable effects for this migration. See preview-queries.ts
// before adding loaders/preloading so the memory and physical-action rules survive.
export const router = createRouter({ routeTree, defaultPreload: false });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
