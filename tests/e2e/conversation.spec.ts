import { randomUUID } from 'node:crypto';

import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const origin = 'http://127.0.0.1:5174';
const password = 'browser-test-only-password';
test.skip(
  !process.env.TEST_DATABASE_URL || !process.env.TEST_REDIS_URL,
  'Explicit loopback PostgreSQL and Redis are required',
);

async function signup(context: BrowserContext) {
  const email = `browser-${randomUUID()}@example.invalid`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await context.request.post(`${origin}/api/auth/sign-up/email`, {
      headers: { origin },
      data: { name: 'Browser E2E', email, password },
    });
    if (response.status() !== 429) {
      expect(response.status()).toBe(200);
      return email;
    }
    // Native auth definitively rejected this request before account creation.
    // Respect its limiter; never apply this retry policy to product submissions.
    const waitSeconds = Number(response.headers()['x-retry-after']);
    expect(waitSeconds).toBeGreaterThan(0);
    expect(waitSeconds).toBeLessThanOrEqual(10);
    await new Promise((resolve) => setTimeout(resolve, (waitSeconds + 0.1) * 1000));
  }
  throw new Error('Native authentication rate limit did not clear.');
}

async function send(page: Page, text: string) {
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/threads\/[^/]+\/turns$/.test(response.url()),
  );
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const response = await accepted;
  expect(response.status()).toBe(202);
  return response.json() as Promise<{ id: string; threadId: string }>;
}

test('submits real durable turns, reloads native history and continues in the same conversation', async ({
  page,
  context,
}) => {
  await signup(context);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'New chat', exact: true })).toBeVisible();
  const first = await send(page, 'First browser message');
  await expect(page).toHaveURL(new RegExp(`/threads/${first.threadId}$`));
  await expect(page.getByText('I have read: First browser message', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('I have read: First browser message', { exact: true })).toBeVisible();
  const saved = page
    .getByRole('navigation', { name: 'Chat history' })
    .getByRole('link', { name: 'First browser message', exact: true });
  await expect(saved).toBeVisible();
  await page.getByRole('link', { name: 'New chat', exact: true }).click();
  await saved.click();
  await expect(page.getByText('I have read: First browser message', { exact: true })).toBeVisible();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy answer', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    'I have read: First browser message',
  );
  const second = await send(page, 'Continue browser conversation');
  expect(second.threadId).toBe(first.threadId);
  await expect(
    page.getByText('Earlier request: First browser message', { exact: true }),
  ).toBeVisible();
  const history = await context.request.get(`${origin}/api/threads/${first.threadId}/turns`);
  expect((await history.json()).turns).toHaveLength(2);
});

test('renders native streaming before formal settlement and reconnects without cancelling or duplicating output', async ({
  page,
  context,
}) => {
  await signup(context);
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    const stats = { created: 0, errors: 0, activities: 0 };
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        stats.created += 1;
        this.addEventListener('activity', () => {
          stats.activities += 1;
        });
        this.addEventListener('error', () => {
          stats.errors += 1;
        });
      }
    };
    Object.assign(window, { __sourceStats: stats });
  });
  await page.goto('/');
  // Do not enable CDP request interception here: Chromium loses EventSource's
  // automatic Last-Event-ID when Playwright continues intercepted requests.
  // The loopback fault proxy blocks backup detail reads after disconnect instead.
  const subscriptions: { cursor: string | undefined }[] = [];
  page.on('response', async (response) => {
    if (/\/api\/turns\/[^/]+\/events$/.test(response.url()))
      subscriptions.push({
        cursor: (await response.headerValue('x-fixture-replay-cursor')) ?? undefined,
      });
  });
  const turn = await send(page, 'STREAM_TEXT: observe genuine native deltas');
  const live = page.getByRole('region', { name: 'Live activity', exact: true });
  await expect(live.getByText(/Streaming begins now/)).toBeVisible();
  const before = await context.request.get(`${origin}/api/turns/${turn.id}`);
  const pending = await before.json();
  expect(pending.status).toBe('running');
  expect(pending.result).toBeNull();
  // Browser offline emulation leaves an established SSE socket alive. Sever real
  // observer bytes in the fixture proxy, not native execution or synthetic events.
  const disconnected = await context.request.post(`${origin}/api/__test/disconnect/${turn.id}`, {
    headers: { 'x-fixture-control': 'disconnect' },
  });
  expect(disconnected.status()).toBe(200);
  expect((await disconnected.json()).disconnected).toBeGreaterThan(0);
  await expect
    .poll(() => subscriptions.some((subscription) => !!subscription.cursor), { timeout: 10000 })
    .toBe(true);
  const resumed = await context.request.get(`${origin}/api/turns/${turn.id}`, {
    headers: { 'x-fixture-inspect': 'sql' },
  });
  expect((await resumed.json()).status).toBe('running');
  const expected = `Streaming begins now. ${'A genuine native delta. '.repeat(160)}Streaming finished.`;
  await expect(live).toBeVisible();
  expect(expected.startsWith((await live.innerText()).trim())).toBe(true);
  const stats = await page.evaluate(
    () =>
      (
        window as Window & {
          __sourceStats?: { created: number; errors: number; activities: number };
        }
      ).__sourceStats,
  );
  expect(stats?.created).toBe(1);
  expect(stats?.errors).toBeGreaterThanOrEqual(1);
  expect(stats?.activities).toBeGreaterThan(1);
  await expect(page.getByRole('button', { name: 'Copy answer', exact: true })).toBeVisible();
  await expect(live).toHaveCount(0);
  const formal = await context.request.get(`${origin}/api/turns/${turn.id}`, {
    headers: { 'x-fixture-inspect': 'sql' },
  });
  const completed = await formal.json();
  expect(completed.status).toBe('completed');
  const answer = completed.result.messages
    .map((message: { content: string }) => message.content)
    .join('');
  expect(answer).toBe(expected);
  expect(answer.match(/A genuine native delta\./g)).toHaveLength(160);
  await expect(page.getByText(answer, { exact: true })).toBeVisible();
});

test('shows actual reasoning activity without exposing private thinking text', async ({
  page,
  context,
}) => {
  await signup(context);
  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;
    const wire: string[] = [];
    Object.assign(window, { __activityWire: wire });
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options);
        this.addEventListener('activity', (event: MessageEvent<string>) => {
          if (wire.length < 1000) wire.push(event.data);
        });
      }
    };
  });
  await page.goto('/');
  await send(page, 'STREAM_REASONING: show only public process status');
  await expect(page.getByText('Reasoning in progress…', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Reasoning completed. This is the public answer.', { exact: true }),
  ).toBeVisible();
  const wire = await page.evaluate(
    () => (window as Window & { __activityWire?: string[] }).__activityWire?.join('\n') ?? '',
  );
  expect(wire).toContain('reasoning');
  expect(wire).not.toContain('Private fixture reasoning');
  await expect(page.getByText(/Private fixture reasoning/)).toHaveCount(0);
});

test('observes a native web-search tool before receiving the source-backed formal answer', async ({
  page,
  context,
}) => {
  await signup(context);
  await page.goto('/');
  const turn = await send(page, 'WEB_SEARCH: find official React state guidance');
  const tool = page.locator('summary').filter({ hasText: 'Web search' });
  await expect(tool).toContainText('Arguments complete · awaiting result');
  const status = await context.request.get(`${origin}/api/turns/${turn.id}`);
  expect((await status.json()).status).toBe('running');
  await tool.click();
  await expect(page.getByText('No result observed yet.', { exact: true })).toBeVisible();
  const source = page.getByRole('link', { name: 'React state structure', exact: true });
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute(
    'href',
    'https://react.dev/learn/choosing-the-state-structure',
  );
  await expect(page.getByRole('button', { name: 'Copy answer', exact: true })).toBeVisible();
});

test('cancels during native web-search IO and joins the tool before allowing another turn', async ({
  page,
  context,
}) => {
  await signup(context);
  await page.goto('/');
  const turn = await send(page, 'WEB_SEARCH: interrupt the actual native tool');
  await expect(page.locator('summary').filter({ hasText: 'Web search' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel turn', exact: true }).click();
  await expect(page.getByText('Cancelled.', { exact: true })).toBeVisible();
  const response = await context.request.get(`${origin}/api/turns/${turn.id}`);
  expect((await response.json()).status).toBe('cancelled');
  await send(page, 'After native tool cancellation');
  await expect(
    page.getByText('I have read: After native tool cancellation', { exact: true }),
  ).toBeVisible();
});

test('retries an uncertain accepted response with the identical request identity and input', async ({
  page,
  context,
}) => {
  await signup(context);
  await page.goto('/');
  await page.goto('/status');
  await page.getByRole('link', { name: '← Back to chat', exact: true }).click();
  const submissions: unknown[] = [];
  await page.route('**/api/threads/*/turns', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions.push(route.request().postDataJSON());
    if (submissions.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      return route.abort('failed');
    }
    return route.continue();
  });
  const draft = '  Preserve exact input\nwith whitespace  ';
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(draft);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry request', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(draft);
  await page.goBack();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Runtime status', exact: true })).toBeVisible();
  await page.goForward();
  await page.goForward();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(draft);
  await page.getByRole('button', { name: 'Retry request', exact: true }).click();
  await expect(page.getByText(/I have read:.*Preserve exact input/)).toBeVisible();
  expect(submissions).toHaveLength(2);
  expect(submissions[1]).toEqual(submissions[0]);
  const threadId = page.url().split('/').at(-1);
  const history = await context.request.get(`${origin}/api/threads/${threadId}/turns`);
  expect((await history.json()).turns).toHaveLength(1);
});

test('requests cancellation while running, waits for settled cancellation and permits a later turn', async ({
  page,
  context,
}) => {
  await signup(context);
  await page.goto('/');
  const turn = await send(page, 'SLOW_CANCEL: stop this long-running request');
  await expect
    .poll(async () => {
      const response = await context.request.get(`${origin}/api/turns/${turn.id}`);
      return (await response.json()).status;
    })
    .toBe('running');
  await expect(
    page.getByRole('region', { name: 'Live activity', exact: true }).getByText(/Working carefully/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel turn', exact: true }).click();
  await expect(page.getByText('Cancelled.', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Live activity', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeEnabled();
  await send(page, 'After cancellation');
  await expect(page.getByText('I have read: After cancellation', { exact: true })).toBeVisible();
});

test('isolates private conversations from a second authenticated account', async ({
  page,
  context,
  browser,
}) => {
  await signup(context);
  await page.goto('/');
  const turn = await send(page, 'Private account conversation');
  await expect(
    page.getByText('I have read: Private account conversation', { exact: true }),
  ).toBeVisible();
  const secondContext = await browser.newContext();
  try {
    const otherEmail = await signup(secondContext);
    const otherPage = await secondContext.newPage();
    await otherPage.goto(`${origin}/threads/${turn.threadId}`);
    await expect(
      otherPage.getByText('Unable to load this conversation. It may not belong to your account.', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(otherPage.getByText('Private account conversation', { exact: true })).toHaveCount(
      0,
    );
    const response = await secondContext.request.get(`${origin}/api/threads`);
    expect((await response.json()).threads).toEqual([]);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Email', { exact: true }).fill(otherEmail);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('dialog').getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'Chat history' }).getByRole('link'),
    ).toHaveCount(0);
    await expect(page.getByText('Private account conversation', { exact: true })).toHaveCount(0);
  } finally {
    await secondContext.close();
  }
});

test('renders Markdown without executing raw HTML, unsafe links or remote image requests', async ({
  page,
  context,
}) => {
  await signup(context);
  const remoteImages: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('example.invalid/tracker')) remoteImages.push(request.url());
  });
  await page.goto('/');
  await send(page, 'MARKDOWN_SAFETY: render untrusted model content safely');
  await expect(page.getByRole('heading', { name: 'Safe result' })).toBeVisible();
  expect(await page.evaluate(() => Object.hasOwn(window, '__injected'))).toBe(false);
  expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
  expect(remoteImages).toEqual([]);
});

test('signs in through the native authentication UI after cookie revocation', async ({
  page,
  context,
}) => {
  const email = await signup(context);
  const response = await context.request.post(`${origin}/api/auth/sign-out`, {
    headers: { origin },
    data: {},
  });
  expect(response.status()).toBe(200);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('dialog').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await send(page, 'Authenticated through the browser');
  await expect(
    page.getByText('I have read: Authenticated through the browser', { exact: true }),
  ).toBeVisible();
});

test('keeps the reference layout usable on a narrow viewport', async ({ page, context }) => {
  await signup(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: 'New chat', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeFocused();
  expect(
    await page
      .locator('main')
      .evaluate((element) => element instanceof HTMLElement && element.inert),
  ).toBe(true);
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .evaluate((element) => element.focus());
  await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('link', { name: 'Multi Harness home', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Multi Harness home', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'New chat', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open sidebar', exact: true })).toBeFocused();
  await send(page, 'A mobile conversation');
  await expect(page.getByText('I have read: A mobile conversation', { exact: true })).toBeVisible();
});

test('keeps a guest draft on its original thread when signing in', async ({ page, context }) => {
  const email = await signup(context);
  const created = await context.request.post(`${origin}/api/threads`, { headers: { origin } });
  expect(created.status()).toBe(201);
  const thread = await created.json();
  const logout = await context.request.post(`${origin}/api/auth/sign-out`, {
    headers: { origin },
    data: {},
  });
  expect(logout.status()).toBe(200);
  await page.goto(`/threads/${thread.id}`);
  const draft = '  Continue this specific conversation  ';
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(draft);
  await page
    .getByRole('complementary', { name: 'Conversations' })
    .getByRole('button', { name: 'Sign in', exact: true })
    .click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('dialog').getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(draft);
  await expect(page).toHaveURL(new RegExp(`/threads/${thread.id}$`));
});
