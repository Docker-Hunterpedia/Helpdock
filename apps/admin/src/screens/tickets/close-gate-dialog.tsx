import type { CustomFieldDef } from '@helpdock/schemas';
import { Box, Typography } from '@mui/material';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { type CustomDraft, draftOf, valueOfDraft } from '../../tickets/custom-values.js';
import { ConfirmDialog } from '../../ui/confirm-dialog.tsx';
import { editorFor } from './custom-fields-card.tsx';

/**
 * "Fill in before closing" (`Admin/Ticketing-FieldFilters`, M14-17): what a
 * close that the required-to-close fields stopped opens instead of a refusal.
 * It names the ticket, draws the fields still empty — each with the "Required
 * to close" marker — and **Save and close** fills them in and closes in one
 * request, so the api judges the values the close would leave behind.
 *
 * The api is the only judge of a value. When it refuses again, `stillEmpty`
 * names what it still wants and the dialog stays open.
 */
export function CloseGateDialog({
  open,
  reference,
  fields,
  stored,
  busy,
  stillEmpty,
  onSubmit,
  onClose,
}: {
  readonly open: boolean;
  /** "HD-1042". */
  readonly reference: string;
  /** The definitions of the fields still empty, in the brand's order. */
  readonly fields: readonly CustomFieldDef[];
  /** The ticket's values, which the editors start from. */
  readonly stored: Readonly<Record<string, unknown>>;
  readonly busy: boolean;
  /** Labels the api named on a second refusal; null before one. */
  readonly stillEmpty: string | null;
  onSubmit(custom: Record<string, unknown>): void;
  onClose(): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const alertId = useId();
  const [drafts, setDrafts] = useState<Record<string, CustomDraft>>({});

  const keys = fields.map((field) => field.key).join('\u0000');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `keys` stands for the list of fields by value, so a refetch of equal definitions does not wipe what is being typed.
  useEffect(() => {
    if (open) {
      setDrafts(Object.fromEntries(fields.map((def) => [def.key, draftOf(def, stored[def.key])])));
    }
  }, [open, keys]);

  const submit = (): void => {
    const custom: Record<string, unknown> = {};
    for (const def of fields) {
      const value = valueOfDraft(def, drafts[def.key] ?? draftOf(def, stored[def.key]));
      if (value !== null) {
        custom[def.key] = value;
      }
    }
    onSubmit(custom);
  };

  return (
    <ConfirmDialog
      open={open}
      busy={busy}
      title={t('tickets:closeGate.title')}
      body={t('tickets:closeGate.body', { ticket: reference })}
      confirmLabel={t('tickets:closeGate.submit')}
      onClose={onClose}
      onConfirm={submit}
    >
      <Box sx={{ display: 'grid', gap: 4 }}>
        {fields.map((def) => (
          <GateField
            key={def.id}
            def={def}
            draft={drafts[def.key] ?? draftOf(def, stored[def.key])}
            locale={locale}
            onDraft={(next) => {
              setDrafts((current) => ({ ...current, [def.key]: next }));
            }}
          />
        ))}
        {stillEmpty === null ? null : (
          <Typography
            id={alertId}
            role="alert"
            variant="caption"
            sx={{ color: tokens['status.danger.text'] }}
          >
            {t('tickets:lifecycle.fields-required-to-close', { fields: stillEmpty })}
          </Typography>
        )}
      </Box>
    </ConfirmDialog>
  );
}

function GateField({
  def,
  draft,
  locale,
  onDraft,
}: {
  readonly def: CustomFieldDef;
  readonly draft: CustomDraft;
  readonly locale: 'en' | 'ar';
  onDraft(next: CustomDraft): void;
}): ReactNode {
  const t = useT();
  const id = useId();
  const markerId = `${id}-marker`;
  const label = locale === 'ar' && def.labelAr !== null ? def.labelAr : def.label;

  return (
    <Box sx={{ display: 'grid', gap: 1 }}>
      <Typography component="label" htmlFor={id} variant="body2" sx={{ fontWeight: 500 }}>
        {label}
      </Typography>
      <Typography id={markerId} variant="caption" sx={{ color: 'text.secondary' }}>
        {t('tickets:details.requiredToClose')}
      </Typography>
      {editorFor({
        def,
        id,
        label,
        draft,
        disabled: false,
        refused: false,
        described: markerId,
        none: t('tickets:details.customNone'),
        onDraft,
        // Nothing is saved on its own here: the primary sends every value at once.
        onCommit: () => undefined,
      })}
    </Box>
  );
}
