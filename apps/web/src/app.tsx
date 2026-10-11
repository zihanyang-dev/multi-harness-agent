import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { Workspace } from './conversation/workspace';

const StatusPage = lazy(() =>
  import('./status/runtime-status').then((module) => ({ default: module.StatusPage })),
);

const rootRoute = createRootRoute({ component: Workspace });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: () => null,
});
const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/threads/$threadId',
  component: () => null,
});
const statusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/status',
  component: () => (
    <Suspense fallback={<p role="status">Loading status…</p>}>
      <StatusPage />
    </Suspense>
  ),
});
export const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, threadRoute, statusRoute]),
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
