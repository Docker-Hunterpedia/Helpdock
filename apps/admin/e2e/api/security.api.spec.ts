import { strings } from '../strings.js';
import { expect, test } from './admin-session.js';
import { resetStepUpBudget, SKIP_ENV } from './install.js';

/**
 * `/me/security` against the real api, for what the mock suite cannot see:
 * how many times a refused step-up goes over the wire (#271). The api answers a
 * wrong current password with a 401, and the transport used to take every 401
 * for an expired token, refresh, and send the same wrong password again — two
 * attempts against the five-per-quarter-hour step-up limit for one click.
 */

test.skip(
  Boolean(process.env[SKIP_ENV]),
  'Docker is not available, so there is no api to run against.',
);

const t = strings('en');

test.describe('the security page against the real api', () => {
  test.beforeEach(resetStepUpBudget);

  test('sends a wrong current password once, without refreshing the session', async ({ page }) => {
    await page.goto('/me/security');
    await page.getByRole('heading', { name: t('me:account.title'), level: 1 }).waitFor();

    const sent: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname === '/api/me/password' || pathname === '/api/auth/refresh') {
        sent.push(pathname);
      }
    });

    await page.getByLabel(t('me:password.currentLabel')).fill('not the password');
    await page.getByLabel(t('me:password.newLabel')).fill('a long enough password');
    await page.getByRole('button', { name: t('me:password.submit') }).click();

    await expect(page.getByText(t('me:password.wrong'))).toBeVisible();
    expect(sent).toEqual(['/api/me/password']);
  });
});
