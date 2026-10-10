import { HealthResponseSchema } from '@multi-harness/protocol';
import { useQuery } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, Outlet } from '@tanstack/react-router';

function RootLayout() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10 sm:py-16">
      <header className="mb-10 border-b border-slate-200 pb-6">
        <p className="mb-3 text-sm font-semibold tracking-wide text-slate-500">MULTI HARNESS</p>
        <h1 className="text-3xl font-semibold tracking-tight">Multi-harness agent scaffold</h1>
        <p className="mt-4 leading-7 text-slate-600">
          A minimal web entry point for checking runtime status. This is a development scaffold, not
          a complete product or a production-ready service.
        </p>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

async function fetchHealth({ signal }: { signal: AbortSignal }) {
  const response = await fetch('/api/healthz', { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: health check failed`);
  }

  const result = HealthResponseSchema.safeParse(await response.json());
  if (!result.success) {
    throw new Error('Health check response does not match the shared protocol');
  }
  return result.data;
}

function HomePage() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    retry: false,
    staleTime: 30_000,
  });

  const healthStatus = health.isPending
    ? 'Checking'
    : health.isError
      ? 'Check failed'
      : 'HTTP service is live (ok)';

  return (
    <div className="space-y-6">
      <section
        aria-labelledby="runtime-heading"
        className="rounded-xl border border-slate-200 bg-white p-6"
      >
        <h2 id="runtime-heading" className="text-lg font-semibold">
          Runtime status
        </h2>
        <dl className="mt-5 space-y-4 text-sm">
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-slate-600">Web entry point</dt>
            <dd className="font-medium">Running</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-slate-600">Agent</dt>
            <dd className="font-medium">Not connected</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-2">
            <dt className="text-slate-600">HTTP health</dt>
            <dd aria-live="polite" className="font-medium">
              {healthStatus}
            </dd>
          </div>
        </dl>
        {health.isError && (
          <p role="alert" className="mt-4 text-sm leading-6 text-red-700">
            {health.error.message}. Check that the local API is running at 127.0.0.1:3000.
          </p>
        )}
        <button
          type="button"
          onClick={() => void health.refetch()}
          disabled={health.isFetching}
          className="mt-5 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-600 disabled:cursor-wait disabled:opacity-50"
        >
          {health.isFetching ? 'Checking...' : 'Check HTTP health again'}
        </button>
        <p className="mt-4 text-sm leading-6 text-slate-500">
          In development, GET /api/healthz proxies to the Hono /healthz endpoint. This checks HTTP
          liveness only, not database, queue, or dependency readiness.
        </p>
      </section>
      <section aria-labelledby="scope-heading" className="rounded-xl border border-slate-200 p-6">
        <h2 id="scope-heading" className="text-lg font-semibold">
          Current scope
        </h2>
        <p className="mt-3 leading-7 text-slate-600">
          React, routing, queries, and styling are connected. Conversation tasks and authentication
          are not implemented. The OpenAI package adapter is not connected to this page, which does
          not submit agent tasks or generate simulated replies.
        </p>
      </section>
    </div>
  );
}

const rootRoute = createRootRoute({ component: RootLayout });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomePage,
});

export const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
