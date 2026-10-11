import { randomBytes, randomUUID } from 'node:crypto';
import type { Thread } from '@multi-harness/protocol/http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestDatabase } from '../../../../tests/integration/database.js';
import { createApp } from '../app.js';
import { createAuth } from './authentication.js';

const baseURL = 'http://localhost:3000';
const secret = randomBytes(32).toString('hex');
const binding = {
  harness: 'pi',
  sdkVersion: '1.1.0',
  provider: 'faux',
  model: 'faux',
  policy: 'text-v1',
  storageId: 'test-volume',
} as const;
let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
let app: ReturnType<typeof createApp>;
let clientIP: string;

function mount(allowSignUp: boolean) {
  auth = createAuth({ pool: fixture.pool, baseURL, secret, allowSignUp });
  app = createApp({
    database: fixture.database,
    binding,
    trustedOrigin: baseURL,
    handleAuth: auth.handler,
    getOwnerId: async (request) =>
      (await auth.api.getSession({ headers: request.headers }))?.user.id,
  });
}
beforeEach(async () => {
  fixture = await createTestDatabase();
  // Native rate-limit memory is process-wide; each fixture represents its own client.
  const octets = randomBytes(3);
  clientIP = `127.${octets[0]}.${octets[1]}.${octets[2]}`;
  mount(true);
});
afterEach(async () => {
  await fixture?.dispose();
});

function request(path: string, method = 'GET', body?: unknown, cookie?: string) {
  return app.request(`${baseURL}${path}`, {
    method,
    headers: {
      origin: baseURL,
      'x-forwarded-for': clientIP,
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function sessionCookie(response: Response) {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('better-auth.session_token='))
    ?.split(';')[0];
  // Assert presence without displaying credential material in failure output.
  expect(typeof cookie).toBe('string');
  return cookie as string;
}
async function signUp(email = 'local@example.invalid') {
  const password = randomBytes(24).toString('hex');
  const response = await request('/auth/sign-up/email', 'POST', {
    name: 'Local test user',
    email,
    password,
  });
  expect(response.status).toBe(200);
  const { user } = (await response.json()) as { user: { id: string } };
  return { userId: user.id, cookie: sessionCookie(response), password, email };
}

it('rejects same-site foreign-origin and missing-origin product mutations without changing rows', async () => {
  const signedUp = await signUp();
  const foreignHeaders = {
    cookie: signedUp.cookie,
    origin: 'http://localhost:3001',
    'content-type': 'application/x-www-form-urlencoded',
  };
  expect(
    (
      await app.request(`${baseURL}/threads`, {
        method: 'POST',
        headers: foreignHeaders,
        body: 'ignored=true',
      })
    ).status,
  ).toBe(403);
  expect((await fixture.pool.query('select id from threads')).rows).toEqual([]);
  const created = await request('/threads', 'POST', undefined, signedUp.cookie);
  expect(created.status).toBe(201);
  const thread = (await created.json()) as Thread;
  const accepted = await request(
    `/threads/${thread.id}/turns`,
    'POST',
    { requestId: randomUUID(), input: { content: [{ type: 'text', text: 'Work' }] } },
    signedUp.cookie,
  );
  expect(accepted.status).toBe(202);
  const turn = (await accepted.json()) as { id: string };
  expect(
    (
      await app.request(`${baseURL}/turns/${turn.id}/cancel`, {
        method: 'POST',
        headers: foreignHeaders,
      })
    ).status,
  ).toBe(403);
  expect(
    (await fixture.pool.query('select status from turns where id = $1', [turn.id])).rows,
  ).toEqual([{ status: 'accepted' }]);
  expect(
    (
      await app.request(`${baseURL}/threads`, {
        method: 'POST',
        headers: { cookie: signedUp.cookie },
      })
    ).status,
  ).toBe(403);
});

it('uses native database sessions for sign-up, thread ownership, login and logout', async () => {
  const signedUp = await signUp();
  const sessionResponse = await request('/auth/get-session', 'GET', undefined, signedUp.cookie);
  expect(sessionResponse.status).toBe(200);
  expect(await sessionResponse.json()).toMatchObject({ user: { id: signedUp.userId } });
  const sessions = await fixture.pool.query('select "userId" from "session"');
  expect(sessions.rows).toEqual([{ userId: signedUp.userId }]);
  const accounts = await fixture.pool.query('select "userId", "providerId" from "account"');
  expect(accounts.rows).toEqual([{ userId: signedUp.userId, providerId: 'credential' }]);

  const created = await request('/threads', 'POST', undefined, signedUp.cookie);
  expect(created.status).toBe(201);
  const thread = (await created.json()) as Thread;
  const row = await fixture.database
    .selectFrom('threads')
    .select('owner_id')
    .where('id', '=', thread.id)
    .executeTakeFirstOrThrow();
  expect(row.owner_id).toBe(signedUp.userId);
  expect((await request(`/threads/${thread.id}`)).status).toBe(401);
  const foreign = await signUp('foreign@example.invalid');
  expect((await request(`/threads/${thread.id}`, 'GET', undefined, foreign.cookie)).status).toBe(
    404,
  );

  const logout = await request('/auth/sign-out', 'POST', {}, signedUp.cookie);
  expect(logout.status).toBe(200);
  expect((await request('/threads', 'POST', undefined, signedUp.cookie)).status).toBe(401);
  const remaining = await fixture.pool.query('select id from "session" where "userId" = $1', [
    signedUp.userId,
  ]);
  expect(remaining.rowCount).toBe(0);

  const login = await request('/auth/sign-in/email', 'POST', {
    email: signedUp.email,
    password: signedUp.password,
  });
  expect(login.status).toBe(200);
  const cookie = sessionCookie(login);
  expect((await request(`/threads/${thread.id}`, 'GET', undefined, cookie)).status).toBe(200);
  // Removing the real database session must revoke ownership even with the signed native cookie.
  await fixture.pool.query('delete from "session" where "userId" = $1', [signedUp.userId]);
  expect((await request(`/threads/${thread.id}`, 'GET', undefined, cookie)).status).toBe(401);
});

it('disables public sign-up without disabling existing account login', async () => {
  const signedUp = await signUp();
  mount(false);
  const response = await request('/auth/sign-up/email', 'POST', {
    name: 'Blocked',
    email: 'blocked@example.invalid',
    password: randomBytes(24).toString('hex'),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED' });
  const users = await fixture.pool.query('select id from "user" where email = $1', [
    'blocked@example.invalid',
  ]);
  expect(users.rowCount).toBe(0);
  const login = await request('/auth/sign-in/email', 'POST', {
    email: signedUp.email,
    password: signedUp.password,
  });
  expect(login.status).toBe(200);
  expect((await request('/threads', 'POST', undefined, sessionCookie(login))).status).toBe(201);
});

it('preserves native origin checks on authentication writes', async () => {
  const response = await app.request(`${baseURL}/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      origin: 'http://foreign.invalid',
      'x-forwarded-for': clientIP,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'Blocked',
      email: 'blocked@example.invalid',
      password: randomBytes(24).toString('hex'),
    }),
  });
  expect(response.status).toBe(403);
  expect((await fixture.pool.query('select id from "account"')).rowCount).toBe(0);
});

it('rejects short secrets and non-root HTTP origins before creating native auth', () => {
  for (const invalidSecret of ['', 'x'.repeat(31)]) {
    expect(() =>
      createAuth({ pool: fixture.pool, baseURL, secret: invalidSecret, allowSignUp: false }),
    ).toThrow();
  }
  for (const invalidURL of [
    'invalid',
    'ftp://localhost:3000',
    'http://localhost:3000/auth',
    'http://localhost:3000?query=1',
    'http://localhost:3000#fragment',
    'http://user:password@localhost:3000',
  ]) {
    expect(() =>
      createAuth({ pool: fixture.pool, baseURL: invalidURL, secret, allowSignUp: false }),
    ).toThrow();
  }
});
