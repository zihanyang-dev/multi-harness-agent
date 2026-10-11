import { type Auth, type BetterAuthOptions, betterAuth } from 'better-auth';
import type { Pool } from 'pg';

/** The caller owns the pool; this factory does not create or destroy it. */
export function createAuth(options: {
  pool: Pool;
  baseURL: string;
  secret: string;
  allowSignUp: boolean;
}): Auth {
  if (options.secret.length < 32)
    throw new Error('Auth secret must contain at least 32 characters');
  let url: URL;
  try {
    url = new URL(options.baseURL);
  } catch {
    throw new Error('Auth base URL must be an HTTP(S) root origin');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('Auth base URL must be an HTTP(S) root origin');
  }

  return betterAuth<BetterAuthOptions>({
    database: options.pool,
    baseURL: url.origin,
    basePath: '/auth',
    secret: options.secret,
    // Keep native origin checks enabled even under the SDK's test-environment default.
    advanced: { disableOriginCheck: false },
    emailAndPassword: { enabled: true, disableSignUp: !options.allowSignUp },
    // Native memory storage protects this process, not a distributed deployment.
    rateLimit: { enabled: true },
  });
}
