import type { Turn } from '@multi-harness/protocol/http';
import { lazy, Suspense } from 'react';
import type { ActivityState } from './activity';
import './markdown.css';

const AnswerMarkdown = lazy(() =>
  import('./answer-markdown').then((module) => ({ default: module.AnswerMarkdown })),
);

function Answer({ text }: { text: string }) {
  if (!text) return null;
  return (
    <Suspense fallback={<div className="whitespace-pre-wrap">{text}</div>}>
      <AnswerMarkdown text={text} />
    </Suspense>
  );
}

export function TurnView({
  turn,
  activity,
  streamAvailable,
  cancellationRequested,
  copied,
  onCopy,
}: {
  turn: Turn;
  activity: ActivityState | undefined;
  streamAvailable: boolean;
  cancellationRequested: boolean;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <section className="mb-8" aria-label="Conversation turn">
      <div className="mb-11 flex justify-end pl-9 md:pl-[46px]">
        <div className="max-w-full rounded-xl bg-[#f5f5f5] px-3 py-[10px] text-[16px] leading-[26px] whitespace-pre-wrap [overflow-wrap:anywhere]">
          {turn.input.content.map((part) => part.text).join('')}
        </div>
      </div>
      <div className="flex items-start gap-[18px] pl-[14px] md:pl-0">
        <span
          className="h-7 w-7 shrink-0 text-[28px] leading-6 font-black text-[#111]"
          aria-hidden="true"
        >
          a
        </span>
        <div className="min-w-0 flex-1 text-[16px] leading-[26px] [overflow-wrap:anywhere]">
          {(turn.status === 'completed' || turn.status === 'cancelled') &&
            turn.result.messages
              .filter(
                (message) => message.role === 'assistant' && typeof message.content === 'string',
              )
              .map((message) => (
                <div className="markdown" key={message.id}>
                  <Answer text={typeof message.content === 'string' ? message.content : ''} />
                </div>
              ))}
          {(turn.status === 'accepted' || turn.status === 'running') && activity && (
            <LiveActivity activity={activity} available={streamAvailable} />
          )}
          <TurnStatus turn={turn} cancellationRequested={cancellationRequested} />
          {turn.status === 'completed' && (
            <button
              type="button"
              className="mt-3 border-0 bg-transparent py-[2px] text-[12px] text-[#888] hover:text-[#333]"
              onClick={onCopy}
            >
              {copied ? 'Copied' : 'Copy answer'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function TurnStatus({
  turn,
  cancellationRequested,
}: {
  turn: Turn;
  cancellationRequested: boolean;
}) {
  let label = '';
  switch (turn.status) {
    case 'accepted':
      label = cancellationRequested
        ? 'Cancellation requested. Waiting for a settled outcome…'
        : 'Request accepted. Waiting for execution…';
      break;
    case 'running':
      label = cancellationRequested
        ? 'Cancellation requested. Waiting for a settled outcome…'
        : 'Running…';
      break;
    case 'needs_reconciliation':
      label = 'Execution unresolved. Needs reconciliation.';
      break;
    case 'cancelled':
      label = 'Cancelled.';
      break;
    case 'failed':
      label = 'Execution failed. No answer was produced.';
      break;
    case 'completed':
      break;
  }
  return label ? (
    <p className="text-[14px] leading-6 text-[#888]" role="status" aria-live="polite">
      {label}
    </p>
  ) : null;
}

function LiveActivity({ activity, available }: { activity: ActivityState; available: boolean }) {
  return (
    <section aria-label="Live activity">
      {activity.messages
        .filter((message) => message.text)
        .map((message) => (
          <div key={message.id} className="markdown">
            <Answer text={message.text} />
          </div>
        ))}
      {Object.entries(activity.process)
        .filter(([, status]) => status === 'started')
        .map(([name]) => (
          <p key={name} className="text-[13px] text-[#777]" role="status">
            {name === 'reasoning'
              ? 'Reasoning in progress…'
              : name === 'compaction'
                ? 'Compacting context…'
                : 'Retrying execution…'}
          </p>
        ))}
      {activity.tools.map((tool) => (
        <details
          key={tool.id}
          className="my-2 rounded-lg border border-[#ddd] px-3 py-2 text-[13px]"
        >
          <summary>
            {tool.name === 'web_search' ? 'Web search' : tool.name} ·{' '}
            {tool.result !== undefined
              ? 'Result received'
              : tool.status === 'finished'
                ? 'Arguments complete · awaiting result'
                : 'Call started'}
          </summary>
          {tool.result !== undefined && (
            <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
              {tool.result}
            </pre>
          )}
          {tool.result === undefined && <p>No result observed yet.</p>}
        </details>
      ))}
      {activity.truncated && (
        <p className="text-[13px] text-[#777]">
          Live preview limit reached. The formal result will replace this preview.
        </p>
      )}
      {(activity.missing || !available) && (
        <p className="text-[13px] text-[#888]" role="status">
          {activity.missing
            ? 'Some live activity is unavailable. Checking the formal status…'
            : 'Live observation reconnecting. Checking the formal status…'}
        </p>
      )}
    </section>
  );
}
