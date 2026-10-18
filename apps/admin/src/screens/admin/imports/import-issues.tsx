import type { importDryRunReportSchema } from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import type { z } from 'zod';
import { useT } from '../../../app/i18n.js';
import { occurrenceKeys } from '../../../imports/occurrence-keys.js';
import { importLogMessageKey } from './import-log-messages.js';

type Issue = z.infer<typeof importDryRunReportSchema>['issues'][number];
function issueKey(code: string) {
  const message = importLogMessageKey(code);
  if (message) return `imports:log.messages.${message}` as const;
  switch (code) {
    case 'file-rows-skipped':
      return 'imports:issues.skippedRows' as const;
    case 'mapping-invalid':
      return 'imports:issues.mapping' as const;
    case 'author-unmapped':
      return 'imports:issues.author' as const;
    case 'identity-ambiguous':
    case 'contact-plan-ambiguous':
    case 'organization-plan-ambiguous':
      return 'imports:issues.identity' as const;
    case 'phone-refused':
      return 'imports:issues.phone' as const;
    case 'field-capacity':
      return 'imports:issues.fieldCapacity' as const;
    case 'field-key-conflict':
    case 'field-binding-conflict':
      return 'imports:issues.fieldConflict' as const;
    case 'target-unavailable':
    case 'reference-missing':
      return 'imports:issues.reference' as const;
    case 'media-unavailable':
      return 'imports:issues.media' as const;
    case 'media-mime_mismatch':
    case 'media-mime_not_allowed':
    case 'media-kind_disabled':
    case 'media-too_large':
    case 'media-unreadable':
    case 'media-size-mismatch':
      return 'imports:issues.mediaSafety' as const;
    case 'media-unreachable':
      return 'imports:issues.mediaUnreachable' as const;
    default:
      return 'imports:dryRun.issue' as const;
  }
}

export function ImportIssues({
  issues,
  busy,
  onReview,
}: {
  issues: Issue[];
  busy: boolean;
  onReview?: ((issue: Issue) => void) | undefined;
}) {
  const t = useT();
  if (!issues.length) return null;
  return (
    <Box component="ul" sx={{ margin: 0, paddingInlineStart: 5, display: 'grid', gap: 3 }}>
      {occurrenceKeys(issues, (issue) => JSON.stringify(issue)).map(({ entry: issue, key }) => (
        <Box component="li" key={key}>
          <Typography>{t(issueKey(issue.code))}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
            {issue.entity ? t(`imports:entities.${issue.entity}`) : t('imports:title')}
            {' · '}
            {t('imports:dryRun.issueReference')} <bdi>{issue.externalId}</bdi>
          </Typography>
          {onReview ? (
            <Button size="small" onClick={() => onReview(issue)} disabled={busy}>
              {t('imports:dryRun.review')}
            </Button>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}
