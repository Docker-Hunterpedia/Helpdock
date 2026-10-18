import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../../../app/preferences.js';
import { renderApp } from '../../../test/render.tsx';
import { ImportIssues } from './import-issues.js';

it.each(['en', 'ar'] as const)(
  'explains vendor source warnings in the %s dry-run review',
  (locale) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    renderApp(
      <ImportIssues
        busy={false}
        issues={[
          {
            area: 'source',
            entity: 'message',
            externalId: 'ticket:42:description',
            code: 'import.message.author-unavailable',
            level: 'warning',
          },
          {
            area: 'source',
            entity: 'article',
            externalId: 'old-article',
            code: 'import.knowledge.readership-restricted',
            level: 'warning',
          },
          {
            area: 'media',
            entity: 'article',
            externalId: 'unsafe-article-file',
            code: 'media-mime_mismatch',
            level: 'error',
          },
          {
            area: 'source',
            entity: 'article',
            externalId: 'article-with-missing-file',
            code: 'import.article.asset-unavailable',
            level: 'warning',
          },
        ]}
      />,
    );
    expect(
      screen.getByText(
        locale === 'en'
          ? 'The source identifies this as a staff message but does not identify its original author.'
          : 'يحدد المصدر هذه الرسالة كرسالة موظف، لكنه لا يحدد كاتبها الأصلي.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === 'en'
          ? 'An article keeps restricted readership.'
          : 'تحتفظ مقالة بقيود الوصول إليها.',
      ),
    ).toBeVisible();
    expect(screen.getByText('ticket:42:description')).toBeVisible();
    expect(screen.getByText('old-article')).toBeVisible();
    expect(
      screen.getByText(
        locale === 'en'
          ? "This file fails the brand's size, type or content safety checks. Review the file or the brand's file policy."
          : 'لم يجتز هذا الملف فحوص الحجم أو النوع أو سلامة المحتوى الخاصة بالعلامة. راجع الملف أو سياسة الملفات للعلامة.',
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        locale === 'en'
          ? 'An article file is unavailable or was refused by the file safety checks. The article includes an availability message.'
          : 'ملف مقالة غير متاح أو رُفض بسبب فحوص أمان الملفات. تتضمن المقالة رسالة توضّح ذلك.',
      ),
    ).toBeVisible();
  },
);
