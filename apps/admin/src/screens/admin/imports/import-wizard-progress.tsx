import type { ImportRunView } from '@helpdock/schemas';
import { Box, Button, Typography } from '@mui/material';
import { Check } from 'lucide-react';
import { useT } from '../../../app/i18n.js';
import { ROUTES } from '../../../app/route-paths.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { visuallyHidden } from '../../../ui/visually-hidden.js';

const STEPS = ['source', 'connect', 'scope', 'extract', 'map', 'dryRun', 'import'] as const;

export function importWizardStep(run: ImportRunView): number {
  const phase = run.status === 'paused' ? run.pausedFrom : run.status;
  if (phase === 'completed' || phase === 'loading' || phase === 'finishing') return 6;
  if (phase === 'dry_run' || phase === 'ready') return 5;
  if (phase === 'awaiting_mapping') return run.hasDryRun ? 5 : 4;
  if (phase === 'extracting') return 3;
  if (phase === 'connecting') return run.hasCredentials || run.sourceAccount !== null ? 2 : 1;
  if (phase === 'draft') return 1;
  if (Object.values(run.counts.loaded).some((count) => (count ?? 0) > 0)) return 6;
  return run.hasDryRun ? 5 : Object.keys(run.counts.extracted).length ? 4 : 1;
}

/** Admin/Import-Wizard's StepProgress; links only lead to editable or visible sections. */
export function ImportWizardProgress({ run, busy }: { run: ImportRunView; busy: boolean }) {
  const t = useT();
  const tokens = useSemanticTokens();
  const current = importWizardStep(run);
  const completed = run.status === 'completed';
  const reviewing = ['awaiting_mapping', 'dry_run', 'ready'].includes(run.status);
  const targets: Partial<Record<(typeof STEPS)[number], string>> = {
    source: ROUTES.brandImport,
    ...(current === 1 && ['draft', 'connecting'].includes(run.status)
      ? { connect: '#import-connect-heading' }
      : {}),
    ...(run.status === 'connecting' && current === 2 ? { scope: '#import-scope-heading' } : {}),
    ...(reviewing
      ? { dryRun: run.hasDryRun ? '#import-dry-run-heading' : '#import-review-start-heading' }
      : {}),
    ...(['awaiting_mapping', 'ready'].includes(run.status)
      ? { map: '#import-mappings-heading' }
      : {}),
    ...(current === 3 ? { extract: '#import-progress-heading' } : {}),
    ...(current === 6 ? { import: '#import-progress-heading' } : {}),
  };
  return (
    <Box component="nav" aria-label={t('imports:wizard.label')}>
      <Box
        component="ol"
        sx={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          display: 'grid',
          gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          gap: 2,
        }}
      >
        {STEPS.map((step, index) => {
          const done = completed || index < current;
          const active = index === current && !completed;
          const href = targets[step];
          return (
            <Box
              component="li"
              key={step}
              aria-current={active ? 'step' : undefined}
              sx={{ minInlineSize: 0, display: 'flex', flexDirection: 'column', gap: 2 }}
            >
              <Box
                aria-hidden="true"
                sx={{
                  blockSize: 4,
                  borderRadius: '999px',
                  backgroundColor:
                    done || active ? tokens['action.primary'] : tokens['border.default'],
                  opacity: active ? 0.5 : 1,
                }}
              />
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'baseline',
                  minBlockSize: 44,
                  gap: 1,
                  color: done
                    ? tokens['action.primary']
                    : active
                      ? tokens['text.primary']
                      : tokens['text.secondary'],
                }}
              >
                {done ? <Check size={14} aria-hidden="true" style={{ flexShrink: 0 }} /> : null}
                {href && !busy ? (
                  <Button
                    component="a"
                    href={href}
                    sx={{
                      padding: 0,
                      minInlineSize: 0,
                      minBlockSize: 44,
                      fontSize: 13,
                      fontWeight: active ? 600 : 400,
                      color: 'inherit',
                      textAlign: 'start',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {t(`imports:wizard.${step}`)}
                  </Button>
                ) : (
                  <Typography
                    variant="caption"
                    sx={{ fontWeight: active ? 600 : 400, overflowWrap: 'anywhere' }}
                  >
                    {t(`imports:wizard.${step}`)}
                  </Typography>
                )}
                {done ? (
                  <Box component="span" sx={visuallyHidden}>
                    {t('imports:wizard.done')}
                  </Box>
                ) : null}
              </Box>
            </Box>
          );
        })}
      </Box>
      <Typography variant="caption" color="text.secondary">
        {t('imports:wizard.remaining', { count: completed ? 0 : STEPS.length - current - 1 })}
      </Typography>
    </Box>
  );
}
