import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { authClient } from '../identity/session';
import { listThreads } from './conversation';

export function Sidebar({ children, onSignIn }: { children: ReactNode; onSignIn: () => void }) {
  const session = authClient.useSession();
  const owner = session.data?.user;
  const [sidebar, setSidebar] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState('');
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  const drawer = useRef<HTMLDivElement>(null);
  const sidebarToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => setMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!mobile || !sidebar || !drawer.current) return;
    const element = drawer.current;
    element.querySelector<HTMLButtonElement>('button')?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSidebar(false);
      } else if (event.key === 'Tab') {
        const controls = [
          ...element.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)'),
        ].filter((control) => control.getClientRects().length > 0);
        const first = controls.at(0);
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    element.addEventListener('keydown', handleKey);
    return () => {
      element.removeEventListener('keydown', handleKey);
      sidebarToggle.current?.focus();
    };
  }, [mobile, sidebar]);
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const threads = useInfiniteQuery({
    queryKey: ['owner', owner?.id, 'threads'],
    enabled: !!owner,
    queryFn: ({ pageParam, signal }) => listThreads(pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });

  async function logout() {
    setError('');
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message ?? 'Sign out failed.');
      await client.cancelQueries({ queryKey: ['owner'] });
      client.removeQueries({ queryKey: ['owner'] });
      setSidebar(false);
      void navigate({ to: '/' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to sign out.');
    }
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      {sidebar && (
        <button
          type="button"
          className="fixed inset-0 z-20 block border-0 bg-[#0003] md:hidden"
          tabIndex={-1}
          aria-label="Close sidebar"
          onClick={() => setSidebar(false)}
        />
      )}
      <div
        ref={drawer}
        className={`group w-[240px] shrink-0 basis-[240px] flex-col bg-shell ${mobile ? (sidebar ? 'fixed inset-y-0 left-0 z-21 flex shadow-[4px_0_30px_#0002]' : 'hidden') : collapsed ? 'hidden' : 'flex'}`}
        {...(mobile && sidebar
          ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Conversations' }
          : { role: 'complementary', 'aria-label': 'Conversations' })}
        inert={mobile ? !sidebar : collapsed}
      >
        <div className="flex h-[62px] items-start justify-between px-[14px] py-[15px]">
          <Link
            to="/"
            className="size-6 text-[30px] leading-[20px] font-black tracking-[-4px] text-[#171717] no-underline"
            aria-label="Multi Harness home"
          >
            a
          </Link>
          <button
            type="button"
            className="inline-flex size-[30px] items-center justify-center rounded-lg border-0 bg-transparent hover:bg-[#00000008] text-[16px] text-[#888] opacity-100 md:opacity-0 md:group-hover:opacity-100 focus-visible:opacity-100"
            aria-label="Collapse sidebar"
            onClick={() => {
              setCollapsed(true);
              setSidebar(false);
            }}
          >
            ◧
          </button>
        </div>
        <Link
          to="/"
          className="mx-2 flex h-[42px] shrink-0 items-center gap-2 rounded-xl border border-[#00000021] bg-white px-3 font-medium text-[#333] no-underline"
          onClick={() => setSidebar(false)}
        >
          <span className="text-[20px]" aria-hidden="true">
            ⊕
          </span>{' '}
          New chat
        </Link>
        <div className="px-4 pt-4 pb-2 leading-5 text-[#8a8a8a]">Chats</div>
        <nav className="flex-1 overflow-y-auto px-2" aria-label="Chat history">
          {threads.data?.pages
            .flatMap((page) => page.threads)
            .map((thread) => (
              <Link
                key={thread.id}
                to="/threads/$threadId"
                params={{ threadId: thread.id }}
                className={`block h-9 truncate rounded-xl px-3 py-2 leading-5 text-[#444] no-underline hover:bg-[#00000006] ${location.pathname === `/threads/${thread.id}` ? 'bg-[#00000006]' : ''}`}
                onClick={() => setSidebar(false)}
              >
                {thread.title || 'New chat'}
              </Link>
            ))}
          {owner && threads.isPending && (
            <p className="mx-2 my-3 text-[13px] text-[#777]">Loading chats…</p>
          )}
          {threads.isError && (
            <div className="mx-2 my-3 text-[13px] text-[#777]">
              <p role="alert">Unable to load chats.</p>
              <button type="button" onClick={() => void threads.refetch()}>
                Try again
              </button>
            </div>
          )}
          {threads.hasNextPage && (
            <button
              type="button"
              className="mx-auto my-3 block rounded-xl border border-[#ddd] bg-white px-3 py-[7px] text-[13px]"
              disabled={threads.isFetchingNextPage}
              onClick={() => void threads.fetchNextPage()}
            >
              Load more chats
            </button>
          )}
        </nav>
        <div className="flex h-[60px] shrink-0 items-center gap-[10px] px-[14px]">
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#e4e7ce] font-semibold text-[#555]">
            {owner?.name?.slice(0, 1).toUpperCase() || 'a'}
          </span>
          {owner ? (
            <>
              <span className="min-w-0 flex-1 truncate">{owner.name}</span>
              <button
                type="button"
                className="inline-flex size-[30px] items-center justify-center rounded-lg border-0 bg-transparent text-[20px] hover:bg-[#00000008]"
                aria-label="Sign out"
                title="Sign out"
                onClick={() => void logout()}
              >
                ↪
              </button>
            </>
          ) : (
            <button
              type="button"
              className="border-0 bg-transparent font-medium"
              disabled={session.isPending}
              onClick={onSignIn}
            >
              {session.isPending ? 'Connecting…' : 'Sign in'}
            </button>
          )}
        </div>
        {error && (
          <p
            role="alert"
            className="text-[13px] leading-5 text-[#a43c32] mx-2 my-3 text-[13px] text-[#777]"
          >
            {error}
          </p>
        )}
      </div>
      <main
        className={`relative my-[6px] mr-[6px] min-w-0 flex-1 overflow-hidden rounded-xl border border-[#0000000d] bg-white ${mobile || collapsed ? 'ml-[6px]' : ''}`}
        inert={mobile && sidebar}
      >
        <button
          ref={sidebarToggle}
          type="button"
          className={`size-[30px] items-center justify-center rounded-lg border-0 bg-transparent hover:bg-[#00000008] absolute top-[11px] left-3 z-5 text-[18px] ${mobile || collapsed ? 'inline-flex' : 'hidden'}`}
          aria-label="Open sidebar"
          onClick={() => {
            setCollapsed(false);
            setSidebar(true);
          }}
        >
          ☰
        </button>
        {children}
      </main>
    </div>
  );
}
