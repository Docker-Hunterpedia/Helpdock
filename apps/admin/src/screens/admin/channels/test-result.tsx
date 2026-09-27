import type { ImapTestResult } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * What "Test IMAP" found, as the `Admin · mailbox form` artboard draws the
 * four answers: a success tint with the folder's counts, or a danger tint
 * naming what refused and — for a refused sign-in — the server's own words,
 * verbatim, because "Invalid credentials" and "Application-specific password
 * required" need different fixes.
 */
export function TestResult({
  result,
  folder,
}: {
  readonly result: ImapTestResult;
  readonly folder: string;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const numbers = new Intl.NumberFormat(locale === 'ar' ? 'ar-u-nu-latn' : locale);
  const tone = result.ok ? 'success' : 'danger';
  const Icon = result.ok ? CircleCheck : TriangleAlert;
  const where = { host: result.host, port: result.port };

  const lines = ((): { title: string; body: ReactNode } => {
    if (result.ok) {
      return {
        title: t('channels:form.test.ok.title', where),
        body: t('channels:form.test.ok.body', {
          folder: result.folder,
          messages: numbers.format(result.messages),
          unseen: numbers.format(result.unseen),
        }),
      };
    }
    switch (result.kind) {
      case 'auth':
        return {
          title: t('channels:form.test.auth.title'),
          body: (
            <>
              <span>{t('channels:form.test.auth.replied', where)}</span>
              {result.serverResponse === null ? null : (
                <Typography
                  variant="mono"
                  component="code"
                  dir="ltr"
                  sx={{
                    fontSize: 12,
                    color: 'text.primary',
                    backgroundColor: tokens['bg.surface'],
                    border: `1px solid ${tokens['border.default']}`,
                    borderRadius: '4px',
                    paddingBlock: 1,
                    paddingInline: 2,
                    wordBreak: 'break-all',
                  }}
                >
                  {result.serverResponse}
                </Typography>
              )}
              <span>{t('channels:form.test.auth.hint')}</span>
            </>
          ),
        };
      case 'folder':
        return {
          title: t('channels:form.test.folder.title', { folder, host: result.host }),
          body: t('channels:form.test.folder.body'),
        };
      case 'timeout':
        return {
          title: t('channels:form.test.timeout.title', where),
          body: t('channels:form.test.timeout.body'),
        };
      default:
        return {
          title: t('channels:form.test.connect.title', where),
          body: t('channels:form.test.connect.body'),
        };
    }
  })();

  return (
    <Box
      role={result.ok ? 'status' : 'alert'}
      sx={{
        display: 'flex',
        gap: 2,
        alignItems: 'flex-start',
        paddingBlock: '10px',
        paddingInline: 3,
        borderRadius: '6px',
        backgroundColor: tokens[`status.${tone}.tint`],
        border: `1px solid ${tokens[`status.${tone}`]}`,
        color: tokens[`status.${tone}.text`],
        fontSize: 13,
        lineHeight: '18px',
      }}
    >
      <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 1 }} />
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
        <Typography component="span" sx={{ fontWeight: 500, fontSize: 13, color: 'inherit' }}>
          {lines.title}
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>{lines.body}</Box>
      </Box>
    </Box>
  );
}
