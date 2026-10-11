import type { Turn } from '@multi-harness/protocol/http';
import type { RefObject } from 'react';
import { canSubmitDraft } from './conversation';

/** Capability text reflects the authorized Thread, never an inferred tool configuration. */
export function Composer({
  draft,
  home,
  capability,
  readOnly,
  blocked,
  blocking,
  cancellationRequested,
  textarea,
  onDraft,
  onSend,
  onCancel,
}: {
  draft: string;
  home: boolean;
  capability: 'Text only' | 'Web search' | 'Text input';
  readOnly: boolean;
  blocked: boolean;
  blocking: Turn | undefined;
  cancellationRequested: boolean;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onDraft: (value: string) => void;
  onSend: () => void;
  onCancel: (turn: Turn) => void;
}) {
  return (
    <form
      className="relative z-1 rounded-3xl border border-[#0000000f] bg-white px-2 pt-3 pb-2 shadow-[0_5px_16px_-4px_#00000012] focus-within:border-[#00000026]"
      onSubmit={(event) => {
        event.preventDefault();
        onSend();
      }}
    >
      <textarea
        className={`mx-2 block w-[calc(100%-16px)] resize-none border-0 bg-transparent p-0 text-[16px] leading-6 text-ink outline-none placeholder:text-[#8f8f8f] placeholder:opacity-100 ${home ? 'h-[120px]' : 'h-12'}`}
        ref={textarea}
        aria-label="Message"
        placeholder="What can I help you with?"
        value={draft}
        readOnly={readOnly}
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229
          ) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <div className="mt-2 flex h-9 items-center justify-between">
        <span className="flex items-center gap-2 px-2 text-[13px] text-[#777]">
          <span className="text-[22px] font-light" aria-hidden="true">
            ≡
          </span>{' '}
          {capability}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-[13px] text-[#777]">Pi</span>
          {blocking && blocking.status !== 'needs_reconciliation' ? (
            <button
              type="button"
              className="grid size-9 place-items-center rounded-full border-0 bg-ink text-white disabled:bg-[#d9d9d9] text-[13px]"
              aria-label="Cancel turn"
              disabled={cancellationRequested}
              onClick={() => onCancel(blocking)}
            >
              ■
            </button>
          ) : (
            <button
              type="submit"
              className="grid size-9 place-items-center rounded-full border-0 bg-ink text-white disabled:bg-[#d9d9d9]"
              aria-label="Send message"
              disabled={blocked || !canSubmitDraft(draft)}
            >
              <ArrowUp />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

function ArrowUp() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 19V5m-6 6 6-6 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
