export type HarnessKind = 'pi' | 'claude' | 'openai';

/** Captures factory configuration before awaiting; never exposes or borrows native SDK objects. */
export type CreateHarness = (config: HarnessConfig) => Promise<Harness>;

/** Fixed connection settings. Credentials are supplied explicitly, never discovered implicitly. */
export type HarnessConfig =
  | { kind: 'pi'; provider: string; model: string; apiKey: string; baseUrl?: string }
  | { kind: 'claude'; model: string; apiKey: string; baseUrl?: string }
  | { kind: 'openai'; model: string; apiKey: string; baseUrl?: string };

/**
 * Configures a native SDK; the SDK owns its loop, history, compaction, retries and continuation.
 * Failed assembly joins cleanup of all resources created by that attempt, even without a handle.
 * Unconfirmed cleanup rejects with execution_unknown, never a stopped-writer or safe-retry receipt.
 */
export interface Harness {
  readonly kind: HarnessKind;
  readonly capabilities: HarnessCapabilities;
  newSession: (options: SessionOptions) => Promise<HarnessSession>;
  /**
   * Opens exact compatible native history without executing input or taking over another writer.
   * Missing history rejects with session_not_found; incompatible history with session_incompatible.
   * Unsupported storage rejects with unsupported. Never selects recent history or starts afresh.
   * Reapplies this handle's bindings. Changed selections are allowed only when native history
   * remains replay-compatible; matching names alone do not prove schema/routing compatibility.
   * Does not reopen a suspended execution state that requires different runtime bindings.
   */
  resumeSession: (options: ResumeSessionOptions) => Promise<HarnessSession>;
}

/**
 * Immutable feature envelope under captured factory configuration, not an event catalog.
 * True means potential support; session storage/resources and each operation still need admission.
 * False means unsupported. Opening sessions never silently changes this envelope.
 */
export interface HarnessCapabilities {
  /** Potential exact-history support; the requested native storage must also be supported. */
  readonly resumeSession: boolean;
  /** Native active-invocation input with target binding and no spillover into another invocation. */
  readonly steer: boolean;
  /** File support does not imply support for every MIME type, source, size or model. */
  readonly input: readonly ('text' | 'file')[];
  /** Whether this configuration can expose reasoning text or summaries; not full hidden reasoning. */
  readonly reasoning: boolean;
  /** Model-requested questions, backed by native interaction or registered SDK tools. */
  readonly questions: boolean;
  /** Potential execution gating; ungateable selected native/hosted routes must still reject. */
  readonly permissionRequests: boolean;
}

/**
 * Host-approved handle configuration, captured before asynchronous assembly on create/resume.
 * Capture paths, selections, JSON data, transport values and callback references, not SDK graphs.
 * Later caller mutation does not reconfigure this handle; changes require a new approved assembly.
 * Host-owned callback dependencies and Skill files are not copied or closed by this declaration.
 * Paths are absolute and authorized; a working directory is not a sandbox or authorization proof.
 */
export interface SessionOptions {
  cwd: string;
  stateDirectory: string;
  /**
   * Additional host instructions for this handle, combined with the native baseline.
   * Applied anew on create/resume; omission adds none, not inherited host configuration.
   * Does not rewrite historical messages or replace execution authorization.
   */
  instructions?: string;
  /** Required host policy, reapplied on resume; it cannot override provider safety boundaries. */
  permissions: PermissionPolicy;
  /**
   * Implementation-native builtin names. Omission uses the fixed Harness baseline in README;
   * [] disables those builtins. A list replaces the baseline, never adds ambient extensions.
   * Discovery/interaction helpers follow explicitly enabled features, not this selector;
   * no filesystem/shell tool is secretly enabled to satisfy an incompatible resource request.
   */
  nativeTools?: readonly string[];
  /** Host callback bindings. Omitted/[] adds none, including on resume; never overrides native names. */
  tools?: readonly ToolDefinition[];
  /** Explicit pre-provisioned sources. Omitted/[] enables none; no ambient skill discovery. */
  skills?: readonly SkillSource[];
  /** Explicit native connections. Omitted/[] adds none; no ambient servers, OAuth or browser login. */
  mcpServers?: readonly McpServerConfig[];
  /**
   * Trusted synchronous disclosure policy for representable, actually observed tool output.
   * Receives detached private data/identity, never SDK objects. Omission/undefined hides this
   * payload; confirmed final results still get empty safe views with independently known isError.
   * A returned view is detached and validated. Ignore its isError and apply only confirmed native
   * classification, omitting that field when unreported. Projection cannot change model output.
   * Throwing, asynchronous or invalid returns disable further payload publication for ALL calls
   * in this invocation, not execution/error facts. Suppression is prospective: an earlier partial
   * remains provisional, is not revoked and never becomes final. Finished alone invents no result.
   * Unrepresentable native data stays native; an empty public view is not an empty ToolOutput.
   * This policy does not prevent assistant text from quoting content already given to the model.
   * Must not block, perform side effects or await this invocation's prompt/interrupt/close.
   */
  projectToolResult?: (
    output: ToolOutput,
    tool: { toolCallId: string; name?: string; phase: 'running' | 'finished' },
  ) => ToolResult | undefined;
}

export interface ResumeSessionOptions extends SessionOptions {
  /** Opaque native identity, meaningful only with compatible implementation, configuration and storage. */
  sessionId: string;
}

/**
 * Owns its native session resources, not global writer exclusion. The host authorizes one writer
 * across all handles/processes targeting the same native identity and storage.
 */
export interface HarnessSession {
  readonly id: string;
  /**
   * Admits one input immediately and resolves after native execution, control IO and callbacks settle.
   *
   * Concurrent prompts on this handle reject with session_busy. Close stops admission immediately;
   * execution_unknown also blocks subsequent execution. Validate admission/input/support first;
   * an already-aborted signal then returns cancelled with empty outputs, without starting native
   * work, writing history or invoking callbacks. Normal completion may win an in-flight cancellation.
   * Settlement joins underlying native control IO and dispatched callbacks, never the public
   * interrupt/close completion promises that observe it. Failures reject with HarnessError;
   * provisional updates are not a replacement formal result.
   */
  prompt: (input: PromptInput, options?: PromptOptions) => Promise<PromptResult>;
  /**
   * Requests cancellation of exactly this invocation through the same path as its signal.
   * Repeated requests share native cancellation and wait for execution/control settlement, not
   * another formal result. An inactive target is a no-op; it never targets a later invocation.
   * Does not close the handle, undo side effects or promise a resumable execution checkpoint.
   */
  interrupt: (invocationId: string) => Promise<void>;
  /**
   * Submits input to the targeted active invocation through native steering, if supported.
   * Resolving means native input processing accepted it, not that the model consumed it.
   * Unsupported input rejects; inactive/cancelling targets reject with invalid_input.
   * Pending input must not outlive this invocation. Never substitutes abort plus a fresh prompt.
   */
  steer: (input: PromptInput, options: { invocationId: string }) => Promise<void>;
  /**
   * Immediately stops admission, cancels active work, joins native execution/controls and releases
   * resources without deleting history. Current prompt retains its actual result/error.
   * Repeated calls share the first completion, including rejection. Subsequent execution rejects
   * with session_closed even after failure; failed close does not certify the writer stopped.
   * Closing an execution_unknown handle does not make that handle reusable.
   */
  close: () => Promise<void>;
}

export interface PromptInput {
  /** Nonempty ordered content; preserves exact text. Unsupported input rejects before submission. */
  content: readonly InputPart[];
}

/**
 * Prompt/steer input bytes are caller-owned and unchanged through related execution settlement.
 * Capture ordered input metadata and validated URL values at admission so mutation cannot redirect
 * submission. HTTPS requires host authorization and native SDK/provider support; no harness-side
 * downloader. Filename is descriptive, not a path to read. Tool callback bytes follow ToolOutput
 * handoff/copy rules, not this input borrowing rule. Public output bytes/URLs are detached;
 * URL authorization and retention belong to their resource owner. Persist needed media before close.
 */
export type InputPart =
  | { type: 'text'; text: string }
  | { type: 'file'; source: URL | Uint8Array; mimeType: string; filename?: string };

/** Capture choices/callback references at admission; retain the live signal for cancellation. */
export interface PromptOptions {
  /**
   * Optional host identity for manual interrupt/steer. Nonempty and never reused on this handle;
   * not a native session ID, checkpoint or authorization. Omission still permits signal cancellation.
   */
  invocationId?: string;
  /** Same invocation cancellation as interrupt. Await prompt to learn its actual outcome. */
  signal?: AbortSignal;
  /**
   * Exposes provider-displayable reasoning in updates and results. Defaults to false; does not
   * set reasoning effort or disclose opaque replay state. Unsupported requests reject before
   * execution. Support does not promise reasoning content on every invocation.
   */
  includeReasoning?: boolean;
  /**
   * Receives provisional facts synchronously; no update kind or complete interval is promised.
   * Throwing disables observation for this invocation, not execution. Must not block or return
   * asynchronous work; slow transport belongs outside. No callbacks occur after prompt settles.
   */
  onUpdate?: (update: HarnessUpdate) => void;
  /**
   * Receives questions initiated by the agent/native tool, not permission requests.
   * Registering this callback does not initiate questions or poll. Requests may overlap and
   * are invocation-scoped. Validate answers against the original IDs and selection rules.
   *
   * Omission disables questions; never invent answers. Unavailable or failed interaction is
   * reported to the native caller without an answer. If it cannot safely continue, prompt
   * rejects with interaction_required or interaction_failed after joining, or execution_unknown
   * if unresolved. Unsupported handlers reject before execution. Cancellation/close aborts the
   * callback signal and expires outstanding requests: late answers are joined but not applied.
   * No new interactions are dispatched after expiry. The host must settle when signal aborts;
   * callbacks must not await this prompt, interrupt or close completion. Closing a question does
   * not cancel the invocation; no second public resume is needed after an answer.
   */
  onQuestion?: (
    request: QuestionRequest,
    options: { signal: AbortSignal },
  ) => Promise<QuestionResponse>;
}

/** Execution disposition, including pre-start cancellation, not a business-success receipt. */
export interface PromptResult {
  /**
   * Requires native evidence except pre-start cancelled. Unknown outcomes reject, never end_turn.
   * max_tokens is an output limit; max_turn_requests uses native agent-loop model-turn accounting,
   * not business prompts, tool-call counts or HTTP retry attempts. Refusal is not inferred from text.
   */
  stopReason: 'end_turn' | 'cancelled' | 'max_tokens' | 'max_turn_requests' | 'refusal';
  /** Native-confirmed assistant output for this invocation, not text reconstructed from updates. */
  messages: readonly AssistantMessage[];
  /**
   * Confirmed final outputs even without observation, in this implementation's observation
   * order, not necessarily wall-clock completion order. At most one result per toolCallId,
   * sharing its update/control identity. Never promote a partial output. Suppressed payloads use
   * empty safe views with confirmed error facts; calls without a confirmed final result are absent.
   */
  toolResults: readonly { toolCallId: string; name?: string; result: ToolResult }[];
  /** Last reported representable plan, not unobserved native state. Ending does not complete it. */
  plan?: readonly PlanEntry[];
  /** Missing counters mean unreported, not zero. */
  usage?: TokenUsage;
}

/** Public output view, not necessarily one native SDK message or a native restoration format. */
export interface AssistantMessage {
  /** Stable, invocation-unique identity; never reused for a retracted attempt. */
  id: string;
  content: readonly AssistantContent[];
}

export interface AssistantContent {
  /**
   * Stable and unique within its message, never repurposed after retraction. Retained IDs keep
   * their content type; corrected text may replace old text. Array order is public content order.
   */
  id: string;
  /** Reasoning is provider-displayable text or summaries, not necessarily complete reasoning. */
  type: 'text' | 'reasoning';
  text: string;
}

/**
 * Confirmed nonnegative integer totals for this invocation, not its last request or session totals.
 * Includes model-loop calls and reported retries/compaction; input includes reported cache tokens
 * without double-counting, output includes reported reasoning. Omit a counter when a complete
 * same-scope total is unavailable. Counters are independently reportable: complete cache totals
 * need not imply a complete input total. Missing is not zero; these are not a billing receipt.
 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Same-scope cache reads included in inputTokens, never added again. Missing is not zero. */
  cacheReadTokens?: number;
  /** Same-scope cache creation/writes included in inputTokens; creation is not another counter. */
  cacheWriteTokens?: number;
}

/**
 * Display-only facts, in source-observation order. No native graph, credentials, private tool
 * payloads, hidden reasoning or opaque replay state. Published DTOs do not share mutable native
 * state; observer mutation or failure cannot change execution/formal output. Reasoning is opt-in.
 * Each tool call has one stable invocation-unique ID shared by updates, controls and results.
 */
export type HarnessUpdate =
  /** Appends to a block present in the current messages view, matching its declared content type. */
  | {
      type: 'text_delta' | 'reasoning_delta';
      messageId: string;
      contentId: string;
      delta: string;
    }
  /**
   * Replaces the entire provisional message view. Declares new blocks before their deltas;
   * corrects final block text and retracts abandoned output. Snapshots never append text.
   */
  | { type: 'messages'; messages: readonly AssistantMessage[] }
  | {
      type: 'tool';
      toolCallId: string;
      name?: string;
      /** Observed phases never regress; a known name is stable. Not side-effect/business success. */
      phase: 'requested' | 'running' | 'finished';
      /**
       * Absent while requested. Replaces output: partial while running, final when finished.
       * Lifecycle constraints are enforced by the implementation, not this shape. Omission leaves
       * the view unchanged but never confirms the old partial output as final. Disclosure failure
       * does not revoke earlier partials; confirmed final results may replace them with empty safe
       * views. Emit one finish per call; skipped phases/cancellation never invent final results.
       */
      result?: ToolResult;
    }
  /** Full representable plan replaces the last report; [] clears only on native evidence. */
  | { type: 'plan'; entries: readonly PlanEntry[] }
  | {
      type: 'activity';
      /** Stable, invocation-unique identity; correlates repeated or overlapping activities. */
      activityId: string;
      name: 'reasoning' | 'compaction' | 'retry';
      /**
       * Observed is a repeatable notice, not a pre-start state. Name stays fixed; start/finish
       * occur at most once each with native evidence, possibly missing a counterpart. No updates
       * follow finish or reuse the ID. Never invent pairs/success or measure hidden inference time.
       * Settlement does not fill missing phases; includeReasoning does not gate activity notices.
       */
      phase: 'observed' | 'started' | 'finished';
    };

export interface PlanEntry {
  content: string;
  /** Native-supported status only; an unrepresentable plan is not published or mapped to pending. */
  status: 'pending' | 'in_progress' | 'completed';
}

/** Local public DTO, not MCP CallToolResult. A safe partial/final view, not a settlement receipt. */
export interface ToolResult {
  /** Same ordered text/file representation as input; may be empty under disclosure policy. */
  content: readonly InputPart[];
  structuredContent?: JsonValue;
  /** Implementation-owned confirmed classification; ignore projector flags. Missing is unreported. */
  isError?: boolean;
  /**
   * True if this public projection size-truncated content or structuredContent. Absent/false means
   * no such projection truncation, not proof of complete native output. Privacy filtering differs.
   */
  truncated?: boolean;
}

/** Finite, acyclic JSON data; implementations validate values, not just TypeScript shapes. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * Session-scoped host tool, converted to SDK objects internally. Names are nonempty and unique;
 * reject routing collisions, unsupported schemas and exposure instead of overriding/dropping tools.
 * Capture data and callback references at assembly. The native SDK owns dispatch and continuation.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /**
   * Finite, acyclic JSON schema with an object root. No implicit external reference fetching.
   * Honor declared constraints or reject. JSON parsing/provider strict sampling is not validation:
   * validate actual arguments before authorization and execute, without lossy coercion.
   */
  inputSchema: { readonly type: 'object'; readonly [keyword: string]: JsonValue };
  /** Successful output must provide structuredContent conforming to this supported JSON schema. */
  outputSchema?: { readonly [keyword: string]: JsonValue };
  /**
   * Model-context exposure only. Omission uses native policy; explicit intent is honored or rejected.
   * Not permission, lazy module import or first-use connection. Discovery stays inside the SDK.
   */
  exposure?: 'immediate' | 'deferred';
  /**
   * Called only by the authorized native execution path with validated JSON arguments.
   * Signal is invocation-bound and incorporates native per-call cancellation where verifiable.
   * Settle on abort; no forced stop/rollback promise. Settlement joins dispatched callbacks;
   * never await this invocation's prompt/interrupt/close. Return an outcome, not a dispatch ACK.
   * Native code decides tool-failure continuation. Invalid output is not published as success.
   */
  execute: (
    input: { readonly [key: string]: JsonValue },
    options: { signal: AbortSignal },
  ) => Promise<ToolOutput>;
}

/**
 * SDK-free model-facing callback output, not a public disclosure grant or native result graph.
 * Validate/capture returned data before native submission; unsupported media is not downloaded.
 * The callback hands off stable data on resolution without concurrent mutation during capture.
 * Copy JSON/media/URL values for native use at that handoff; bytes are not borrowed until prompt
 * settlement. Output schema validates structuredContent, not display content. Return is not confirmation.
 * Also used for detached representable output passed to projectToolResult; unrepresentable native
 * results never become fabricated empty outputs. Native rich data stays intact on its SDK path.
 */
export interface ToolOutput {
  content: readonly InputPart[];
  structuredContent?: JsonValue;
  isError?: boolean;
}

/**
 * One host-authorized absolute, pre-provisioned directory containing SKILL.md and its resources.
 * Native discovery derives metadata and loads instructions/resources; no inline body or plugin
 * fallback. Validate metadata/identity at assembly; reject missing/invalid/conflicting sources.
 * The host keeps the directory, SKILL.md and resources stable for this handle's lifetime.
 * Selection never loads sibling plugin/MCP configuration or executes embedded commands during
 * assembly/disclosure. Incompatible native loading rejects, not a custom loader/interpreter.
 * Skill-directed calls still use approved tools/policy; selection grants no shell/network rights
 * and is not filesystem isolation.
 */
export interface SkillSource {
  directory: string;
}

/**
 * Plain connection declaration; SDK clients/servers/transports are constructed internally.
 * Name is a nonempty unique session identity. Connecting/spawning is separately host-authorized.
 * Capture transport/environment/header values at assembly, never re-read caller-owned config.
 * Owned connections, including partial initialization, close with the session or failed assembly;
 * host callback dependencies do not. Session selection does not require reconnecting every prompt.
 */
export interface McpServerConfig {
  name: string;
  transport:
    | {
        type: 'stdio';
        /** Pre-provisioned executable, not a shell template or an instruction to install a package. */
        command: string;
        args?: readonly string[];
        /** Literal additions to the approved minimal native environment, not credential discovery. */
        env?: { readonly [name: string]: string };
      }
    | {
        /** http is Streamable HTTP; sse is legacy SSE and rejects where unsupported. */
        type: 'http' | 'sse';
        /** Host-authorized native endpoint. No harness proxy or protocol conversion. */
        url: string;
        /** Literal explicitly supplied values, never command templates or implicit auth. */
        headers?: { readonly [name: string]: string };
      };
  /**
   * Server-local original TOOL names. [] permits no tool exposure/calls; all includes future tools.
   * Not execution permission, startup prevention or a grant/ban for resources/prompts/helpers.
   * Initial complete discovery rejects assembly if explicit names are absent. Lists never expand.
   * Later withdrawal removes eligibility; route/schema replacement expires pending approvals.
   * Revalidate the current binding/arguments before dispatch; discard obsolete connection callbacks.
   * Later collisions disable affected routes without overriding tools. Unsafe continuation joins
   * then fails with execution_failed, or execution_unknown if stopping cannot be confirmed.
   */
  allowedTools: 'all' | readonly string[];
  /** Native schema exposure, not connection timing. Explicit intent is honored or rejected. */
  exposure?: 'immediate' | 'deferred';
}

/**
 * Detached non-sensitive control DTO, not a general form schema or URL authorization flow.
 * Retain private original IDs/rules for answer validation; callback mutation cannot change them.
 */
export interface QuestionRequest {
  /** Unique among this invocation's requests. It is not an authorization proof. */
  id: string;
  /** Nonempty validated questions, with nonempty question/choice IDs and display text. */
  questions: readonly Question[];
}

export interface Question {
  /** Unique within the request; answers use this ID rather than matching question text. */
  id: string;
  question: string;
  /** Empty only for a text-only question with allowCustom enabled. */
  options: readonly Choice[];
  multiple: boolean;
  allowCustom: boolean;
}

export interface Choice {
  /** Unique within its question. */
  id: string;
  label: string;
  description?: string;
}

export interface QuestionAnswer {
  questionId: string;
  optionIds: readonly string[];
  /** Custom answer when no option is selected, otherwise a note; requires allowCustom. */
  text?: string;
}

/**
 * Accept submits a subset; omitted questions are skipped and accept + [] explicitly skips all.
 * Decline means choosing not to answer; cancel means withdrawing/dismissing this interaction.
 * Neither cancels execution. Natives with one no-answer outcome may map both to that outcome.
 * Validate one answer per question, unique valid option IDs, at most one selection unless
 * multiple, and a selection or nonempty permitted custom text. Types alone cannot prove this.
 */
export type QuestionResponse =
  | { action: 'accept'; answers: readonly QuestionAnswer[] }
  | { action: 'decline' | 'cancel'; answers?: never };

/**
 * Gates every selected executable tool route, including enabled interaction/discovery helpers.
 * Native auto-grants, annotations or prior SDK grants cannot bypass ask. Unsupported gating rejects
 * before execution. Startup/source reads are separately host-authorized, not tool approval requests.
 * Does not replace host identity, network or sandbox authorization.
 */
export type PermissionPolicy =
  | { mode: 'allow_all' }
  | {
      mode: 'ask';
      /**
       * Decides one exact tool invocation before its side effects. Missing or invalid decisions
       * never authorize it. Callback failure denies this action; continue through the native
       * loop if safe, otherwise reject after joining as onQuestion specifies. The host must
       * settle when signal aborts. Cancellation/close expires pending requests: no new interactions
       * or late decisions are applied; prior grants are not undone. Callbacks must not await this
       * invocation's prompt, interrupt or close completion. Requests may overlap; decisions are
       * single-use, not inherited. Unsupported gating rejects before execution.
       */
      onRequest: (
        request: PermissionRequest,
        options: { signal: AbortSignal },
      ) => Promise<PermissionResponse>;
    };

/**
 * Detached trusted control input. Keep validated arguments/route privately for approval/execution;
 * callback mutation cannot rewrite them. Sensitive arguments are never published as updates.
 */
export interface PermissionRequest {
  /** Invocation-unique decision request, not necessarily one-to-one with a tool call. */
  id: string;
  toolCallId: string;
  /** Identifies the bound executable route, not an untrusted display label or name-prefix grant. */
  toolName: string;
  /** Validated actual arguments; approval cannot be retargeted after a local binding/schema change. */
  input: JsonValue;
}

/** Single-use decision. Persistent approval rules, if any, belong to the host policy. */
export type PermissionResponse = { action: 'allow' } | { action: 'deny'; reason?: string };

/**
 * Normalized public rejection. Message, cause and stack must not expose sensitive native payloads.
 * An uncertain execution/control stop takes precedence over a known failure classification.
 */
export interface HarnessError extends Error {
  /** Admission, history, interaction or execution failure; exact meanings are defined in README. */
  readonly code:
    | 'invalid_config'
    | 'invalid_input'
    | 'unsupported'
    | 'session_not_found'
    | 'session_incompatible'
    | 'session_busy'
    | 'session_closed'
    | 'interaction_required'
    | 'interaction_failed'
    | 'execution_failed'
    | 'execution_unknown';
}
