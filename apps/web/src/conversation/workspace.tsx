import { Link, Outlet, useLocation } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useState } from 'react';
import { authClient, useOwnerCache } from '../identity/session';
import { Conversation } from './conversation-view';
import { Sidebar } from './sidebar';

const AuthForm = lazy(() =>
  import('../identity/authentication').then((module) => ({ default: module.AuthForm })),
);

export function Workspace() {
  const session = authClient.useSession();
  const owner = session.data?.user;
  useOwnerCache(owner?.id);
  const location = useLocation();
  const [authOpen, setAuthOpen] = useState(false);
  const [guestDraft, setGuestDraft] = useState<{ key: string; text: string }>();
  useEffect(() => {
    if (owner) setGuestDraft(undefined);
  }, [owner]);
  return (
    <>
      <Sidebar onSignIn={() => setAuthOpen(true)}>
        {location.pathname === '/status' ? (
          <div className="mx-auto h-full max-w-[800px] overflow-auto px-6 pt-[60px] pb-6">
            <Link to="/">← Back to chat</Link>
            <Outlet />
          </div>
        ) : null}
        <div style={{ display: location.pathname === '/status' ? 'none' : 'contents' }}>
          <Conversation
            key={owner?.id ?? 'anonymous'}
            ownerId={owner?.id}
            authPending={session.isPending}
            initialDraft={guestDraft}
            onGuestDraft={setGuestDraft}
            onSignIn={() => setAuthOpen(true)}
          />
        </div>
      </Sidebar>
      {authOpen && (
        <Suspense fallback={null}>
          <AuthForm onClose={() => setAuthOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
