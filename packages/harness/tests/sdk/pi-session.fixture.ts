import './offline-guard.js';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TranscriptContext, UserMessage } from '@earendil-works/pi-ai';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  Type,
} from '@earendil-works/pi-ai';
import type { ResourceLoader, ToolDefinition } from '@earendil-works/pi-coding-agent';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

import { BLUE_IMAGE, RED_IMAGE } from '../fixtures/media.js';

const cwd = process.cwd();
const contexts: TranscriptContext[] = [];
const interleavedInput: Exclude<UserMessage['content'], string> = [
  { type: 'text', text: 'Text A' },
  { type: 'image', data: RED_IMAGE, mimeType: 'image/png' },
  { type: 'text', text: 'Text B' },
  { type: 'image', data: BLUE_IMAGE, mimeType: 'image/png' },
  { type: 'text', text: 'Text C' },
];

// Use Pi's public deterministic provider; no custom agent loop or private session state.
const faux = fauxProvider({ provider: 'offline-fixture', tokensPerSecond: 1_000_000 });
faux.setResponses([
  (context) => {
    contexts.push(structuredClone(context));
    return fauxAssistantMessage(fauxToolCall('inspect_reference', {}, { id: 'call_offline' }));
  },
  (context) => {
    contexts.push(structuredClone(context));
    return fauxAssistantMessage('Offline response');
  },
  (context) => {
    contexts.push(structuredClone(context));
    return fauxAssistantMessage('Offline resumed response');
  },
]);
const modelRuntime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(),
  modelsPath: null,
  refreshOnCreate: false,
  allowModelNetwork: false,
});
// Registration still refreshes builtin availability. HOME/env are isolated by runSdkFixture.
modelRuntime.registerNativeProvider(faux.provider);
const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => 'You are an offline test fixture.',
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};
let toolExecutions = 0;
const customTool: ToolDefinition = {
  name: 'inspect_reference',
  label: 'Inspect reference',
  description: 'Return synthetic reference content.',
  parameters: Type.Object({}),
  execute: async () => {
    toolExecutions += 1;
    return {
      content: [
        { type: 'text', text: 'Tool text' },
        { type: 'image', data: BLUE_IMAGE, mimeType: 'image/png' },
      ],
      details: {},
    };
  },
};
const options = {
  cwd,
  agentDir: join(cwd, 'agent'),
  model: faux.getModel(),
  thinkingLevel: 'off' as const,
  modelRuntime,
  resourceLoader,
  customTools: [customTool],
  tools: ['inspect_reference'],
  settingsManager: SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: 'off',
    images: { autoResize: false },
  }),
};
const manager = SessionManager.create(cwd, join(cwd, 'sessions'));
const { session } = await createAgentSession({ ...options, sessionManager: manager });
let sessionMessages: unknown;
let sessionJsonl: string;
let sessionFile: string;
try {
  await session.sendUserMessage(interleavedInput);
  sessionMessages = structuredClone(session.messages);
  const file = manager.getSessionFile();
  if (!file) throw new Error('Pi did not create a native session file.');
  sessionFile = file;
  sessionJsonl = await readFile(file, 'utf8');
} finally {
  session.dispose();
}
const restoredManager = SessionManager.open(sessionFile);
const { session: restored } = await createAgentSession({
  ...options,
  sessionManager: restoredManager,
});
let restoredMessages: unknown;
try {
  restoredMessages = structuredClone(restored.messages);
  await restored.prompt('Resume check');
} finally {
  restored.dispose();
}
process.stdout.write(
  JSON.stringify({
    stage: 'sdk-provider-context-and-native-jsonl',
    input: interleavedInput,
    contexts,
    sessionMessages,
    restoredMessages,
    sessionJsonl,
    toolExecutions,
  }),
);
