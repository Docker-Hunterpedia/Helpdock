import { HC_CUSTOM_CSS_MAX, type HcCssRemoval, type HcCustomCssResult } from '@helpdock/schemas';
import { Box, Button, IconButton, TextField, Typography } from '@mui/material';
import { ShieldAlert, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';
import { SectionCard } from '../../admin/channels/section-card.tsx';
import { useHelpCenter } from '../use-help-center.js';
import { useSiteSave } from './use-site.js';

/**
 * "Custom CSS" (M5-06, `Admin/HelpCenter-Settings`, DESIGN §8): the brand's
 * stylesheet, applied after the theme. The api sanitises it on save; what it
 * removed is listed under the field, each with the reason in a sentence, until
 * dismissed.
 */
export function CustomCssCard({
  css,
  canManage,
}: {
  readonly css: string;
  readonly canManage: boolean;
}): ReactNode {
  const t = useT();
  const id = useId();
  const tokens = useSemanticTokens();
  const { api } = useHelpCenter();
  const [draft, setDraft] = useState(css);
  const [removed, setRemoved] = useState<readonly HcCssRemoval[]>([]);
  useEffect(() => {
    setDraft(css);
  }, [css]);

  const save = useSiteSave(
    api.saveCustomCss.bind(api),
    (site, result: HcCustomCssResult) => ({ ...site, customCss: result.css }),
    (result) => setRemoved(result.removed),
  );
  const fieldId = `${id}-css`;

  return (
    <SectionCard
      id={`${id}-custom-css`}
      heading={t('helpCenter:site.css.heading')}
      caption={t('helpCenter:site.css.caption')}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        save.mutate(draft);
      }}
      {...(canManage
        ? {
            footer: (
              <>
                <Button variant="text" disabled={save.isPending} onClick={() => setDraft(css)}>
                  {t('helpCenter:settings.discard')}
                </Button>
                <Button type="submit" variant="contained" disabled={save.isPending}>
                  {t('helpCenter:settings.save')}
                </Button>
              </>
            ),
          }
        : {})}
    >
      <Typography component="label" htmlFor={fieldId} sx={{ fontSize: 13, fontWeight: 500 }}>
        {t('helpCenter:site.css.label')}
      </Typography>
      <TextField
        id={fieldId}
        multiline
        minRows={6}
        value={draft}
        disabled={!canManage}
        onChange={(event) => setDraft(event.target.value)}
        slotProps={{
          htmlInput: { dir: 'ltr', spellCheck: false, maxLength: HC_CUSTOM_CSS_MAX },
        }}
        sx={{ '& textarea': { fontFamily: 'var(--hd-font-mono, monospace)', fontSize: 13 } }}
      />
      {removed.length === 0 ? null : (
        <Box
          role="status"
          sx={{
            display: 'flex',
            gap: 3,
            padding: 3,
            borderRadius: '6px',
            backgroundColor: tokens['status.warning.tint'],
            border: `1px solid ${tokens['status.warning']}`,
            color: tokens['status.warning.text'],
            fontSize: 13,
          }}
        >
          <ShieldAlert
            size={16}
            aria-hidden="true"
            style={{ flexShrink: 0, marginBlockStart: 2 }}
          />
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, flexGrow: 1, minWidth: 0 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
              {t('helpCenter:site.css.removedTitle')}
            </Typography>
            <Box
              component="ul"
              sx={{
                margin: 0,
                paddingInlineStart: 4,
                display: 'flex',
                flexDirection: 'column',
                gap: 1,
              }}
            >
              {removed.map((entry, index) => (
                // The same rule can be dropped twice; the position tells them apart.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above.
                <Box component="li" key={index} sx={{ display: 'flex', flexDirection: 'column' }}>
                  <Box
                    component="code"
                    dir="ltr"
                    sx={{
                      fontFamily: 'var(--hd-font-mono, monospace)',
                      fontSize: 12,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {entry.rule}
                  </Box>
                  <span>{t(`helpCenter:site.css.reasons.${entry.reason}`)}</span>
                </Box>
              ))}
            </Box>
          </Box>
          <IconButton
            size="small"
            aria-label={t('helpCenter:site.css.dismiss')}
            onClick={() => setRemoved([])}
            sx={{ color: 'inherit', width: 28, height: 28, alignSelf: 'flex-start' }}
          >
            <X size={14} aria-hidden="true" />
          </IconButton>
        </Box>
      )}
    </SectionCard>
  );
}
