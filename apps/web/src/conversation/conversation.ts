import {
  type SubmitTurn,
  SubmitTurnSchema,
  ThreadListSchema,
  ThreadSchema,
  type Turn,
  TurnSchema,
} from '@multi-harness/protocol';

export function canSubmitDraft(draft: string): boolean {
  return draft.trim().length > 0 && draft.length <= 32000;
}

export function createSubmission(draft: string, requestId: string): SubmitTurn {
  return SubmitTurnSchema.parse({ requestId, input: { content: [{ type: 'text', text: draft }] } });
}

export function isBlockingStatus(status: Turn['status']): boolean {
  return status === 'accepted' || status === 'running' || status === 'needs_reconciliation';
}

export function isUncertainFailure(error: unknown): boolean {
  return !(
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 500
  );
}

export async function request(path: string, options?: RequestInit): Promise<unknown> {
  const response = await fetch(`/api${path}`, { ...options, credentials: 'same-origin' });
  if (!response.ok) {
    throw Object.assign(new Error(`Request failed (HTTP ${response.status}).`), {
      status: response.status,
    });
  }
  return response.json();
}

export async function listThreads(after: string | null, signal: AbortSignal) {
  return ThreadListSchema.parse(
    await request(`/threads${after ? `?after=${after}` : ''}`, { signal }),
  );
}

/** Reads authorized identity and stored capabilities, never a client-selected tool binding. */
export async function getThread(threadId: string, signal: AbortSignal) {
  return ThreadSchema.parse(await request(`/threads/${threadId}`, { signal }));
}

export async function listTurns(threadId: string, after: string | null, signal: AbortSignal) {
  const page = await request(`/threads/${threadId}/turns${after ? `?after=${after}` : ''}`, {
    signal,
  });
  if (
    typeof page !== 'object' ||
    page === null ||
    !('turns' in page) ||
    !('nextCursor' in page) ||
    !(page.nextCursor === null || typeof page.nextCursor === 'string')
  )
    throw new Error('Invalid turn history response.');
  return { turns: TurnSchema.array().parse(page.turns), nextCursor: page.nextCursor };
}

export async function submitTurn(threadId: string, submission: SubmitTurn) {
  return TurnSchema.parse(
    await request(`/threads/${threadId}/turns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submission),
    }),
  );
}

/** HTTP recovery can finish after SSE; a stale read cannot rewind durable lifecycle facts. */
export function preferTurnSnapshot(current: Turn | undefined, incoming: Turn): Turn {
  if (!current || current.id !== incoming.id) return incoming;
  if (!isBlockingStatus(current.status)) return current;
  if (
    current.status === 'needs_reconciliation' &&
    (incoming.status === 'accepted' || incoming.status === 'running')
  )
    return current;
  if (current.status === 'running' && incoming.status === 'accepted') return current;
  return incoming;
}
