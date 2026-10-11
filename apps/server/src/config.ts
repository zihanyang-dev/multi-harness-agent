import { type PiBinding, PiBindingSchema } from '@multi-harness/protocol/execution';
import { z } from 'zod';

export interface ServerConfig {
  hostname: string;
  port: number;
  backend:
    | {
        databaseURL: string;
        redisURL: string;
        prefix: string;
        baseURL: string;
        secret: string;
        allowSignUp: boolean;
        binding: PiBinding;
      }
    | undefined;
}

/** Infrastructure and credentials are read only behind the explicit product capability gate. */
export function readServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const hostname = z
    .string()
    .min(1)
    .parse(environment.HOST ?? '127.0.0.1');
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(environment.PORT ?? '3000');
  const enabled = z.enum(['0', '1']).parse(environment.AGENT_BACKEND_ENABLED ?? '0');
  if (enabled === '0') return { hostname, port, backend: undefined };
  const databaseURL = z.url({ protocol: /^postgres(?:ql)?$/ }).parse(environment.DATABASE_URL);
  const redisURL = z.url({ protocol: /^rediss?$/ }).parse(environment.REDIS_URL);
  const baseURL = z.url({ protocol: /^https?$/ }).parse(environment.BETTER_AUTH_URL);
  const secret = z.string().min(32).parse(environment.BETTER_AUTH_SECRET);
  const allowSignUp = z.enum(['0', '1']).parse(environment.AUTH_ALLOW_SIGN_UP ?? '0') === '1';
  const binding = PiBindingSchema.parse({
    harness: 'pi',
    sdkVersion: '1.1.0',
    policy: 'text-v1',
    provider: environment.PI_PROVIDER,
    model: environment.PI_MODEL,
    storageId: environment.PI_STORAGE_ID,
  });
  return {
    hostname,
    port,
    backend: { databaseURL, redisURL, prefix: 'mha', baseURL, secret, allowSignUp, binding },
  };
}
