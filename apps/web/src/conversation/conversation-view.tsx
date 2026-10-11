import { type SubmitTurn, ThreadSchema, type Turn, TurnSchema } from '@multi-harness/protocol';
import {
  type InfiniteData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Composer } from './composer';
import {
  canSubmitDraft,
  createSubmission,
  getThread,
  isBlockingStatus,
  isUncertainFailure,
  listTurns,
  preferTurnSnapshot,
  request,
  submitTurn,
} from './conversation';
import { TurnView } from './turn-view';
import { useTurnEvents } from './use-turn-events';

const starters = ['Plan', 'Draft', 'Compare', 'Explain', 'Review', 'Brainstorm'];
const starterDrafts: Record<string, string> = {
  Plan: 'Help me plan ',
  Draft: 'Help me draft ',
  Compare: 'Compare ',
  Explain: 'Explain ',
  Review: 'Review ',
  Brainstorm: 'Brainstorm ideas for ',
};
type PendingRequest = { submission: SubmitTurn; uncertain: boolean };

/** Page-lifetime drafts and exact request identity; public snapshots remain authoritative. */
export function Conversation({
  ownerId,
  authPending,
  onSignIn,
  onGuestDraft,
  initialDraft,
}: {
  ownerId: string | undefined;
  authPending: boolean;
  onSignIn: () => void;
  onGuestDraft: (draft: { key: string; text: string }) => void;
  initialDraft: { key: string; text: string } | undefined;
}) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const threadId = pathname.startsWith('/threads/')
    ? pathname.slice('/threads/'.length)
    : undefined;
  const draftKey = threadId ?? 'home';
  const [drafts, setDrafts] = useState<Record<string, string>>(
    initialDraft ? { [initialDraft.key]: initialDraft.text } : {},
  );
  const [pending, setPending] = useState<Record<string, PendingRequest>>({});
  const [accepted, setAccepted] = useState<Record<string, Turn>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [cancelRequested, setCancelRequested] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const actionLock = useRef(false);
  const mounted = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const client = useQueryClient();
  const navigate = useNavigate();
  const draft = drafts[draftKey] ?? '';
  const thread = useQuery({
    queryKey: ['owner', ownerId, 'thread', threadId],
    enabled: !!ownerId && !!threadId,
    queryFn: ({ signal }) => getThread(threadId ?? '', signal),
    retry: false,
  });
  const history = useInfiniteQuery({
    queryKey: ['owner', ownerId, 'turns', threadId],
    enabled: !!ownerId && !!threadId && thread.isSuccess,
    queryFn: ({ pageParam, signal }) => listTurns(threadId ?? '', pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  });
  const localTurn = threadId ? accepted[threadId] : undefined;
  const candidates = new Map<string, Turn>();
  for (const page of history.data?.pages ?? [])
    for (const turn of page.turns) candidates.set(turn.id, turn);
  if (localTurn)
    candidates.set(localTurn.id, preferTurnSnapshot(candidates.get(localTurn.id), localTurn));
  const observedTurn =
    [...candidates.values()].find((turn) => isBlockingStatus(turn.status)) ??
    (localTurn ? candidates.get(localTurn.id) : undefined);

  function receiveTurn(incoming: Turn) {
    const turn = preferTurnSnapshot(
      client.getQueryData<Turn>(['owner', ownerId, 'turn', incoming.id]),
      incoming,
    );
    setAccepted((current) => ({ ...current, [turn.threadId]: turn }));
    client.setQueryData(['owner', ownerId, 'turn', turn.id], turn);
    client.setQueryData<InfiniteData<Awaited<ReturnType<typeof listTurns>>>>(
      ['owner', ownerId, 'turns', turn.threadId],
      (current) =>
        current && {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            turns: page.turns.map((existing) =>
              existing.id === turn.id ? preferTurnSnapshot(existing, turn) : existing,
            ),
          })),
        },
    );
    if (!isBlockingStatus(turn.status))
      void client.invalidateQueries({ queryKey: ['owner', ownerId, 'turns', turn.threadId] });
  }
  const stream = useTurnEvents(ownerId, observedTurn, receiveTurn);
  const observation = useQuery({
    queryKey: ['owner', ownerId, 'turn', observedTurn?.id],
    enabled: !!ownerId && !!observedTurn,
    queryFn: async ({ signal }) => {
      const snapshot = TurnSchema.parse(await request(`/turns/${observedTurn?.id}`, { signal }));
      return preferTurnSnapshot(
        client.getQueryData<Turn>(['owner', ownerId, 'turn', snapshot.id]),
        snapshot,
      );
    },
    initialData: observedTurn,
    retry: false,
    refetchInterval: (query) =>
      query.state.data && isBlockingStatus(query.state.data.status) && !stream.available
        ? 5000
        : false,
  });
  if (observation.data)
    candidates.set(
      observation.data.id,
      preferTurnSnapshot(candidates.get(observation.data.id), observation.data),
    );
  const orderedTurns = [...candidates.values()].sort(
    (a, b) => a.acceptedAt.localeCompare(b.acceptedAt) || a.id.localeCompare(b.id),
  );
  const blocking = orderedTurns.find((turn) => isBlockingStatus(turn.status));
  const pendingRequest = threadId ? pending[threadId] : undefined;
  const historyUnavailable =
    !!ownerId &&
    !!threadId &&
    (!thread.isSuccess || !history.isSuccess || history.hasNextPage || history.isFetching);
  const blocked = busy || !!pendingRequest || !!blocking || historyUnavailable || authPending;
  const error = errors[draftKey];
  const hasPendingRequest = Object.keys(pending).length > 0;
  const title =
    orderedTurns[0]?.input.content
      .map((part) => part.text)
      .join(' ')
      .trim() || 'New chat';

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!hasPendingRequest) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasPendingRequest]);
  // Scroll on navigation and added turns, not on every status poll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: These are the transcript scroll triggers.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [threadId, orderedTurns.length]);
  useEffect(() => {
    const snapshot = observation.data;
    if (!snapshot) return;
    setAccepted((current) =>
      current[snapshot.threadId] === snapshot
        ? current
        : {
            ...current,
            [snapshot.threadId]: preferTurnSnapshot(current[snapshot.threadId], snapshot),
          },
    );
    if (!isBlockingStatus(snapshot.status)) {
      void client.invalidateQueries({ queryKey: ['owner', ownerId, 'turns', snapshot.threadId] });
    }
  }, [client, ownerId, observation.data]);

  function updateDraft(value: string, key = draftKey) {
    setDrafts((current) => ({ ...current, [key]: value }));
    if (!ownerId) onGuestDraft({ key, text: value });
  }
  function setError(key: string, message: string) {
    setErrors((current) => ({ ...current, [key]: message }));
  }

  async function send(retry = false) {
    if (actionLock.current || (!retry && blocked) || (retry && !pendingRequest?.uncertain)) return;
    if (!ownerId) {
      onSignIn();
      return;
    }
    if (!retry && !canSubmitDraft(draft)) return;
    actionLock.current = true;
    setBusy(true);
    let target = threadId;
    const submission =
      retry && pendingRequest
        ? pendingRequest.submission
        : createSubmission(draft, crypto.randomUUID());
    setError(draftKey, '');
    try {
      if (!target) {
        const created = ThreadSchema.parse(await request('/threads', { method: 'POST' }));
        if (!mounted.current) return;
        target = created.id;
        updateDraft(draft, target);
        updateDraft('', 'home');
        client.setQueryData(['owner', ownerId, 'thread', target], created);
        void client.invalidateQueries({ queryKey: ['owner', ownerId, 'threads'] });
        await navigate({ to: '/threads/$threadId', params: { threadId: target } });
      }
      if (!mounted.current) return;
      const targetId = target;
      setPending((current) => ({ ...current, [targetId]: { submission, uncertain: false } }));
      try {
        const turn = await submitTurn(targetId, submission);
        if (!mounted.current) return;
        setAccepted((current) => ({ ...current, [targetId]: turn }));
        client.setQueryData(['owner', ownerId, 'turn', turn.id], turn);
        updateDraft('', targetId);
        setPending((current) => {
          const next = { ...current };
          delete next[targetId];
          return next;
        });
        void client.invalidateQueries({ queryKey: ['owner', ownerId, 'threads'] });
        void client.invalidateQueries({ queryKey: ['owner', ownerId, 'turns', targetId] });
      } catch (cause) {
        if (!mounted.current) return;
        const uncertain = isUncertainFailure(cause);
        setPending((current) => {
          const next = { ...current };
          if (uncertain || retry) next[targetId] = { submission, uncertain: true };
          else delete next[targetId];
          return next;
        });
        setError(
          targetId,
          uncertain || retry
            ? 'Request outcome unknown. Your exact input is retained. Retry the same request to check acceptance.'
            : cause instanceof Error
              ? cause.message
              : 'Request was not accepted.',
        );
        if (!uncertain)
          void client.invalidateQueries({ queryKey: ['owner', ownerId, 'turns', targetId] });
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          target ?? draftKey,
          cause instanceof Error
            ? cause.message
            : 'Unable to create a conversation. Your draft is retained.',
        );
    } finally {
      actionLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function cancel(turn: Turn) {
    if (cancelRequested[turn.id]) return;
    setCancelRequested((current) => ({ ...current, [turn.id]: true }));
    try {
      const result = TurnSchema.parse(
        await request(`/turns/${turn.id}/cancel`, { method: 'POST' }),
      );
      if (!mounted.current) return;
      receiveTurn(result);
    } catch {
      if (!mounted.current) return;
      setCancelRequested((current) => ({ ...current, [turn.id]: false }));
      setError(turn.threadId, 'Cancellation could not be confirmed. The turn is still unresolved.');
    }
  }

  const composer = (
    <div className="relative w-[768px] max-w-full">
      {(error ||
        blocking?.status === 'needs_reconciliation' ||
        pendingRequest?.uncertain ||
        observation.isError) && (
        <div
          className="mb-2 rounded-xl bg-[#faf7ee] px-4 py-2 text-[13px] leading-5"
          aria-live="polite"
        >
          {blocking?.status === 'needs_reconciliation' ? (
            <p>
              Execution is unresolved and needs reconciliation ({blocking.failureCode}). New
              messages are paused; no safe resume is available.
            </p>
          ) : (
            <p>
              {error ||
                (observation.isError
                  ? 'Unable to observe this turn. New messages remain paused.'
                  : 'Request outcome unknown.')}
            </p>
          )}
          {pendingRequest?.uncertain && (
            <>
              <p>
                Keep this page open. Reloading or signing out loses the request identity; check
                history before sending again.
              </p>
              <button
                className="border-0 bg-transparent py-1 underline"
                type="button"
                disabled={busy}
                onClick={() => void send(true)}
              >
                Retry request
              </button>
            </>
          )}
          {observation.isError && (
            <button
              className="border-0 bg-transparent py-1 underline"
              type="button"
              onClick={() => void observation.refetch()}
            >
              Check status
            </button>
          )}
        </div>
      )}
      <Composer
        draft={draft}
        home={!threadId}
        capability={
          thread.data?.tools?.includes('web_search')
            ? 'Web search'
            : thread.data?.tools
              ? 'Text only'
              : 'Text input'
        }
        readOnly={!!pendingRequest || busy}
        blocked={blocked}
        blocking={blocking}
        cancellationRequested={!!(blocking && cancelRequested[blocking.id])}
        textarea={textarea}
        onDraft={updateDraft}
        onSend={() => void send()}
        onCancel={(turn) => void cancel(turn)}
      />
      {!threadId && (
        <div className="mx-5 -mt-9 flex h-[84px] items-center gap-5 rounded-b-3xl bg-[#f6f6f6] px-3 pt-9 text-[12px] text-[#666] md:gap-7 md:px-5 md:text-[14px]">
          <span>Text conversations</span>
          <span>Pi harness</span>
          <span className="ml-auto hidden md:inline">Your own workspace</span>
        </div>
      )}
      {draft.length > 32000 && (
        <p role="alert" className="text-[13px] leading-5 text-[#a43c32] px-4 py-1">
          Keep your message within 32,000 characters. Your draft has not been changed.
        </p>
      )}
    </div>
  );

  return threadId ? (
    <div className="flex h-full flex-col">
      <header className="flex h-[52px] shrink-0 items-center pr-4 pl-[54px] md:px-6">
        <h1 className="m-0 truncate text-[16px] leading-6 font-normal">{title.slice(0, 120)}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3 md:px-4 md:pt-4">
        <div className="mx-auto w-[800px] max-w-full md:px-4">
          {!ownerId && !authPending && (
            <p className="text-[14px] leading-6 text-[#888]">
              Sign in to view this conversation.{' '}
              <button
                className="border-0 bg-transparent py-1 underline"
                type="button"
                onClick={onSignIn}
              >
                Sign in
              </button>
            </p>
          )}
          {ownerId && (thread.isPending || history.isPending) && !thread.isError && (
            <p className="text-[14px] leading-6 text-[#888]">Loading conversation…</p>
          )}
          {(thread.isError || history.isError) && (
            <div className="text-[14px] leading-6 text-[#888]" role="alert">
              <p>Unable to load this conversation. It may not belong to your account.</p>
              <button
                className="border-0 bg-transparent py-1 underline"
                type="button"
                onClick={() => {
                  void thread.refetch();
                  void history.refetch();
                }}
              >
                Try again
              </button>
            </div>
          )}
          {orderedTurns.map((turn) => (
            <TurnView
              key={turn.id}
              turn={turn}
              activity={stream.activity.turnId === turn.id ? stream.activity : undefined}
              streamAvailable={stream.available}
              cancellationRequested={!!cancelRequested[turn.id]}
              copied={copied === turn.id}
              onCopy={async () => {
                if (turn.status !== 'completed') return;
                const text = turn.result.messages
                  .filter((message) => message.role === 'assistant')
                  .map((message) => (typeof message.content === 'string' ? message.content : ''))
                  .join('\n\n');
                try {
                  await navigator.clipboard.writeText(text);
                  if (mounted.current) setCopied(turn.id);
                } catch {
                  if (mounted.current)
                    setError(turn.threadId, 'Clipboard unavailable. Select the answer to copy it.');
                }
              }}
            />
          ))}
          {history.hasNextPage && (
            <button
              type="button"
              className="mx-auto my-3 block rounded-xl border border-[#ddd] bg-white px-3 py-[7px] text-[13px]"
              disabled={history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              Load more messages
            </button>
          )}
          {pendingRequest &&
            !orderedTurns.some(
              (turn) =>
                turn.input.content.map((part) => part.text).join('') ===
                pendingRequest.submission.input.content.map((part) => part.text).join(''),
            ) && (
              <div className="mb-11 flex justify-end pl-9 md:pl-[46px]">
                <div className="max-w-full rounded-xl bg-[#f5f5f5] px-3 py-[10px] text-[16px] leading-[26px] whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {pendingRequest.submission.input.content.map((part) => part.text).join('')}
                </div>
              </div>
            )}
          <div ref={bottom} />
        </div>
      </div>
      <div className="flex shrink-0 justify-center px-3 pb-5 md:pb-2">{composer}</div>
    </div>
  ) : (
    <div className="flex h-full items-center justify-center px-3">
      <div className="relative mt-[52px] w-[768px] max-w-full md:mt-7">
        <div
          className="mx-auto mb-8 flex h-[82px] w-[400px] max-w-full items-center justify-center font-[Arial,sans-serif] text-[48px] leading-none font-extrabold tracking-[1px] text-black md:text-[62px]"
          role="img"
          aria-label="Multi Harness"
        >
          AGENT
        </div>
        {composer}
        <fieldset
          className="mt-8 flex min-w-0 flex-nowrap justify-start gap-3 overflow-x-auto border-0 px-8 [scrollbar-width:none] md:flex-wrap md:justify-center md:overflow-visible md:p-0"
          aria-label="Conversation starters"
        >
          {starters.map((starter, index) => (
            <button
              type="button"
              className="inline-flex h-9 shrink-0 items-center gap-[7px] rounded-[20px] border border-[#00000021] bg-white px-[11px] text-[13px] leading-5 text-[#666] hover:bg-[#f8f8f8] md:px-[13px] md:text-[14px]"
              key={starter}
              onClick={() => {
                updateDraft(starterDrafts[starter] ?? '');
                textarea.current?.focus();
              }}
            >
              <span className="text-[16px]" aria-hidden="true">
                {['◇', '▤', '⇄', '◉', '✓', '✧'][index]}
              </span>
              {starter}
            </button>
          ))}
        </fieldset>
      </div>
    </div>
  );
}
