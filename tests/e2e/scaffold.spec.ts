import { expect, test } from '@playwright/test';

test('connects the web shell to the real HTTP liveness endpoint', async ({ page }) => {
  await page.goto('/status');

  await expect(page.getByRole('heading', { name: 'Runtime status' })).toBeVisible();
  await expect(page.getByText('HTTP service is live (ok)')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);

  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/api/healthz'),
  );
  await page.getByRole('button', { name: 'Check HTTP health again' }).click();
  const response = await responsePromise;

  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok' });
});
