import AxeBuilder from '@axe-core/playwright';
import { LOCALE_STORAGE_KEY } from '../../src/app/preferences.js';
import { strings } from '../strings.js';
import { expect, test } from './admin-session.js';
import {
  OIDC_CONTROL_KEY_ENV,
  SAML_CERTIFICATE_ENV,
  SAML_CONTROL_KEY_ENV,
  SKIP_ENV,
} from './install.js';

test.skip(Boolean(process.env[SKIP_ENV]), 'Docker is required for SSO provisioning.');
for (const protocol of ['oidc', 'saml'] as const) {
  for (const locale of ['en', 'ar'] as const) {
    test(`${protocol} previews without writes, provisions and revokes removed access (${locale})`, async ({
      page,
      browser,
      baseURL,
    }) => {
      const t = strings(locale);
      const controlOrigin = protocol === 'oidc' ? 'http://127.0.0.1:8080' : 'http://127.0.0.1:8443';
      const key =
        process.env[protocol === 'oidc' ? OIDC_CONTROL_KEY_ENV : SAML_CONTROL_KEY_ENV] ?? '';
      // Enabled connections may not share a domain, and the seeded ones list example.com.
      const domain = `jit-${protocol}-${locale}.example.com`;
      const identity = {
        subject: `jit-${protocol}-${locale}`,
        email: `person@${domain}`,
        groups: ['Support'],
      };
      const setGroups = async (groups: string[]) => {
        const response = await page.request.post(`${controlOrigin}/__fixture/identity`, {
          headers: { authorization: `Bearer ${key}` },
          data: { ...identity, groups },
        });
        expect(response.status()).toBe(204);
      };
      await setGroups(['Support']);
      const refreshed = await page.request.post('/api/auth/refresh');
      expect(refreshed.ok()).toBe(true);
      const { accessToken } = (await refreshed.json()) as { accessToken: string };
      const headers = { authorization: `Bearer ${accessToken}` };
      const targetsResponse = await page.request.get('/api/install/sso/targets', { headers });
      expect(targetsResponse.ok()).toBe(true);
      const targets = (await targetsResponse.json()) as { brands: { id: string }[] };
      const brandId = targets.brands[0]?.id;
      if (!brandId) throw new Error('Missing brand fixture');
      const config =
        protocol === 'oidc'
          ? {
              protocol,
              issuer: controlOrigin,
              clientId: 'helpdock',
            }
          : {
              protocol,
              idpEntityId: controlOrigin,
              idpSsoUrl: `${controlOrigin}/sso`,
              idpCertificates: [process.env[SAML_CERTIFICATE_ENV]],
              emailAttribute: 'email',
              nameAttribute: 'name',
            };
      const created = await page.request.post('/api/install/sso/configurations', {
        headers,
        data: {
          connection: {
            name: `JIT ${protocol} ${locale}`,
            enabled: true,
            emailDomains: [domain],
            jitEnabled: true,
            idpEnforcesMfa: true,
            groupAttribute: 'groups',
            defaultAccess: null,
            config,
            ...(protocol === 'oidc' ? { clientSecret: 'test-secret' } : {}),
          },
          mappings: [
            { idpGroup: 'Support', brandId, role: 'viewer', departmentIds: null, position: 0 },
          ],
        },
      });
      expect(created.status()).toBe(201);
      const { id } = (await created.json()) as { id: string };
      const tested = await page.request.post(`/api/install/sso/connections/${id}/test`, {
        headers,
      });
      expect(tested.ok()).toBe(true);
      const { startUrl } = (await tested.json()) as { startUrl: string };
      await page.goto(startUrl);
      // The initiating admin remains signed in; only the preview is consumed.
      await expect(page.getByText(strings('en')('sso:wouldCreate'), { exact: true })).toBeVisible();
      const previewed = await page.request.get(`/api/install/sso/connections/${id}`, { headers });
      expect((await previewed.json()).peopleCount).toBe(0);

      const visitor = await browser.newContext(baseURL === undefined ? {} : { baseURL });
      await visitor.addInitScript(
        ([storageKey, language]) => window.localStorage.setItem(storageKey ?? '', language ?? ''),
        [LOCALE_STORAGE_KEY, locale],
      );
      const signInPage = await visitor.newPage();
      try {
        await signInPage.goto(`/api/auth/sso/${id}/start`);
        await expect(
          signInPage.getByRole('navigation', { name: t('admin:nav.label') }),
        ).toBeVisible();
        expect(
          (
            await new AxeBuilder({ page: signInPage })
              .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
              .analyze()
          ).violations,
        ).toEqual([]);
        const staff = await page.request.get(`/api/brands/${brandId}/staff`, { headers });
        expect(staff.ok()).toBe(true);
        expect((await staff.json()).staff).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              email: identity.email,
              source: 'sso',
              ssoLinked: true,
              managedBy: `JIT ${protocol} ${locale}`,
              role: 'viewer',
            }),
          ]),
        );
        await setGroups([]);
        await signInPage.goto(`/api/auth/sso/${id}/start`);
        await expect(signInPage.getByRole('alert')).toHaveText(t('auth:sso.errors.sso-no-access'));
        expect((await signInPage.request.post('/api/auth/refresh')).status()).toBe(401);
        const remaining = await page.request.get(`/api/brands/${brandId}/staff`, { headers });
        expect((await remaining.json()).staff).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ email: identity.email })]),
        );
      } finally {
        await visitor.close();
        const restored = await page.request.post(`${controlOrigin}/__fixture/identity`, {
          headers: { authorization: `Bearer ${key}` },
          data: { subject: 'staff-1', email: 'ada@example.com', groups: ['Support'] },
        });
        expect(restored.status()).toBe(204);
      }
    });
  }
}
