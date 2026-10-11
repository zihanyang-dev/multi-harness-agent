# Pi turn host

`createPiTurnHost` binds a trusted Pi 1.1.0 `ModelRuntime` and a schema-validated,
snapshotted `PiBinding` to the fixed `text-v1` product policy. The runtime graph
and its credentials remain caller-owned; the host never constructs default auth
or a default runtime.

The caller supplies an absolute, private `stateRoot` (including trusted ancestors
and no untrusted symlinks), already scoped to the binding's `storageId`. Each UUID
thread uses `<stateRoot>/<threadId>/{workspace,sessions,agent}`. New directories
are created with mode `0700`; this is not a sandbox or a cross-process writer lock.
The server authorizes admission; worker claims coordinate exclusive native writers.

Native `SessionManager` owns transcript persistence. Resume requires an exact
native ID in that thread's sessions directory; missing history rejects, and public
messages are never used to reconstruct model context. A newly allocated native ID
or filename is not proof of a persisted transcript: Pi may defer writing until a
model response. Tests verify persistence only after a completed prompt.

This policy disables resource discovery (extensions, skills, prompt templates,
themes, context files), supplies `tools: []`, and disables prompt-template expansion.
It is product scope, not a portable adapter whitelist. With no extensions loaded,
there is no extension startup work requiring `bindExtensions`.

Cache warming is off. Native compaction is enabled with SDK 1.1.0 token-budget
defaults. Standard native retry is enabled with three retries and SDK delay/provider
retry defaults; there is no additional platform retry loop. The adapter owns prompt
settlement and joins it before invoking the host-transferred native `dispose`.
Partial setup cleanup only disposes native objects actually returned to the host;
SDK-internal construction failures remain the SDK's responsibility.

`host.test.ts` launches `host.sdk.test.ts` in a whitelisted environment with
a temporary HOME/agent directory and explicit offline/fixture flags. The fixture
uses official faux providers and in-memory credential/model stores, never a CLI or
network model call. Root Vitest configuration must exclude the child suite.
