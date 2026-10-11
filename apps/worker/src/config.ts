import { isAbsolute } from 'node:path';
import { type PiBinding, PiBindingSchema } from '@multi-harness/protocol/execution';
import { z } from 'zod';

export interface WorkerConfig {
  databaseURL: string;
  redisURL: string;
  stateRoot: string;
  apiKey: string;
  maxRunMs: number;
  binding: PiBinding;
  prefix: string;
}

/** A deployment supplies one explicit native profile; no personal Pi credential discovery. */
export function readWorkerConfig(environment: NodeJS.ProcessEnv): WorkerConfig | undefined {
  const enabled = z.enum(['0', '1']).parse(environment.AGENT_BACKEND_ENABLED ?? '0');
  if (enabled === '0') return;
  const databaseURL = z.url({ protocol: /^postgres(?:ql)?$/ }).parse(environment.DATABASE_URL);
  const redisURL = z.url({ protocol: /^rediss?$/ }).parse(environment.REDIS_URL);
  const stateRoot = z.string().refine(isAbsolute).parse(environment.PI_STATE_ROOT);
  const apiKey = z.string().trim().min(1).parse(environment.PI_API_KEY);
  // These native Vertex markers resolve to no key and would fall back to ambient ADC.
  if (
    environment.PI_PROVIDER === 'google-vertex' &&
    (apiKey === 'gcp-vertex-credentials' || /^<[^>]+>$/.test(apiKey))
  ) {
    throw new Error('Vertex requires an explicit API key');
  }
  const maxRunMs = z.coerce
    .number()
    .int()
    .min(1)
    .max(2_147_483_647)
    .parse(environment.TURN_MAX_RUN_MS ?? '120000');
  const binding = PiBindingSchema.parse({
    harness: 'pi',
    sdkVersion: '1.1.0',
    policy: 'text-v1',
    provider: environment.PI_PROVIDER,
    model: environment.PI_MODEL,
    storageId: environment.PI_STORAGE_ID,
  });
  return { databaseURL, redisURL, stateRoot, apiKey, maxRunMs, binding, prefix: 'mha' };
}
