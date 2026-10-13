import AxeBuilder from '@axe-core/playwright';
import { fakeSamlSigningKey } from './api/fake-saml.js';
import { expect, test } from './fixtures.js';
import { openSettings, signIn } from './flows.js';
import { strings } from './strings.js';

test('SSO settings validate, save a provider and mappings, and refuse invalid enforcement', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  await signIn(page, locale);
  await openSettings(page, locale);
  await page.getByRole('tab', { name: t('sso:title') }).click();
  await expect(page.getByText(t('sso:empty'))).toBeVisible();
  await page.getByRole('checkbox', { name: t('sso:require') }).check();
  await page.getByRole('button', { name: t('common:actions.save'), exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(t('sso:saveError'));
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);

  await page.getByRole('link', { name: t('sso:add'), exact: true }).click();
  await page.getByRole('button', { name: t('sso:saveConnection') }).click();
  await expect(page.getByRole('alert')).toContainText(t('sso:invalid'));
  await page.getByLabel(t('sso:label')).fill('Work OIDC');
  await page.getByLabel(t('sso:issuer')).fill('https://idp.example.com');
  await page.getByLabel(t('sso:clientId')).fill('helpdock');
  await page.getByLabel(t('sso:clientSecret'), { exact: true }).fill('never-return-this');
  await page.getByLabel(t('sso:domains'), { exact: true }).fill('example.com');
  await page.getByRole('checkbox', { name: t('sso:enabled'), exact: true }).check();
  await page.getByRole('button', { name: t('sso:addMapping') }).click();
  await page.getByLabel(t('sso:group'), { exact: true }).fill('Support');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('button', { name: t('sso:saveConnection') }).click();
  await expect(page.getByRole('heading', { name: 'Work OIDC', level: 1 })).toBeVisible();
  await expect(page.locator('input[value="never-return-this"]')).toHaveCount(0);
  await expect(page.getByLabel(t('sso:group'), { exact: true })).toHaveValue('Support');
  await expect(page.getByRole('button', { name: t('sso:test'), exact: true })).toBeEnabled();
  await page.getByLabel(t('sso:label')).fill('Changed unsaved');
  await expect(page.getByRole('button', { name: t('sso:test'), exact: true })).toBeDisabled();
  await page.getByRole('link', { name: t('sso:title'), exact: true }).click();
  await expect(page.getByRole('link', { name: 'Work OIDC', exact: true })).toBeVisible();
});

test('SAML configuration and enforced discovery use bilingual controls', async ({
  page,
  appLocale: locale,
}) => {
  const t = strings(locale);
  const certificate = (await fakeSamlSigningKey()).certificate;
  await signIn(page, locale);
  await openSettings(page, locale);
  await page.getByRole('tab', { name: t('sso:title') }).click();
  await page.getByRole('link', { name: t('sso:add'), exact: true }).click();
  await page.getByRole('button', { name: 'SAML 2.0', exact: true }).click();
  await page.getByLabel(t('sso:label')).fill('Work SAML');
  await page.getByLabel(t('sso:idpEntityId')).fill('https://idp.example.com/saml');
  await page.getByLabel(t('sso:idpSsoUrl')).fill('https://idp.example.com/sign-in');
  await page.getByRole('button', { name: t('sso:addCertificate'), exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(t('sso:certificatePem')).fill(certificate);
  await dialog.getByRole('button', { name: t('sso:addCertificate'), exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByLabel(t('sso:domains'), { exact: true }).fill('example.com');
  await page.getByRole('checkbox', { name: t('sso:enabled'), exact: true }).check();
  await page.getByRole('button', { name: t('sso:saveConnection') }).click();
  await expect(page.getByRole('heading', { name: 'Work SAML', level: 1 })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('link', { name: t('sso:title'), exact: true }).click();
  await page.getByRole('checkbox', { name: t('sso:require') }).check();
  await page.getByRole('combobox', { name: t('sso:breakGlass') }).click();
  await page.getByRole('option', { name: 'Lina Haddad' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: t('common:actions.save'), exact: true }).click();
  await expect(page.getByText(t('sso:saved'))).toBeVisible();
  await page
    .getByRole('button', { name: t('admin:currentUser.menuLabel', { name: 'Lina Haddad' }) })
    .click();
  await page.getByRole('menuitem', { name: t('admin:currentUser.signOut') }).click();
  await expect(page.getByLabel(t('auth:sso.workEmail'))).toBeVisible();
  await expect(page.getByLabel(t('auth:signIn.passwordLabel'))).toHaveCount(0);
  await page.getByLabel(t('auth:sso.workEmail')).fill('unknown@elsewhere.example');
  await page.getByRole('button', { name: t('auth:sso.continue'), exact: true }).click();
  await expect(page.getByText(t('auth:sso.noConnection'))).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('button', { name: t('auth:sso.breakGlass') }).click();
  await expect(page.getByLabel(t('auth:signIn.passwordLabel'))).toBeVisible();
});
