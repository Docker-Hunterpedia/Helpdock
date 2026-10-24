import type { CustomFieldDef, Ticket } from '@helpdock/schemas';
import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../../app/i18n.js';
import { usePreferences } from '../../app/providers.tsx';
import { useSemanticTokens } from '../../app/tokens.js';
import { fieldLabel } from '../../tickets/custom-values.js';
import { visuallyHidden } from '../../ui/visually-hidden.js';
import { TagChip } from '../admin/ticketing/tag-chip.tsx';

/**
 * The brand's pinned field on a ticket (M14-16, `Admin/Ticketing-FieldFilters`
 * panel 2): its value as a neutral chip, on the row's caption line and in the
 * ticket header. It is the answer to "Severity" without a column of its own.
 *
 * Neutral on purpose. A hue would give the field a meaning the brand did not
 * choose, and DESIGN §1 says a hue never carries two. The value is always in
 * words; the name of the field is there for a screen reader, since "Sev 1"
 * alone could be anything.
 *
 * Nothing is drawn for a ticket with no value, so a row that has not been
 * triaged does not say so with an empty chip.
 */

/** The pinned field's value on `ticket`, or `null` when it carries none. */
export const pinnedValueOf = (
  ticket: Pick<Ticket, 'custom'>,
  def: Pick<CustomFieldDef, 'key'> | undefined,
): string | null => {
  const value = def === undefined ? undefined : ticket.custom[def.key];

  return typeof value === 'string' && value !== '' ? value : null;
};

export function PinnedFieldChip({
  def,
  value,
  size,
}: {
  readonly def: CustomFieldDef;
  readonly value: string;
  /** `row` is the caption-line chip; `header` is the 22 px Tag of the ticket header. */
  readonly size: 'row' | 'header';
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const name = t('tickets:pinned.name', { field: fieldLabel(def, locale) });

  if (size === 'header') {
    return (
      <>
        <Box component="span" sx={visuallyHidden}>
          {name}
        </Box>
        <TagChip tag={{ name: value, nameAr: null, color: 'stone' }} />
      </>
    );
  }

  return (
    <Box
      component="span"
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
        paddingInline: 1,
        borderRadius: '4px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.muted'],
        color: tokens['text.primary'],
        fontSize: 12,
        fontWeight: 500,
        lineHeight: '16px',
      }}
    >
      <Box component="span" sx={visuallyHidden}>
        {name}
      </Box>
      {value}
    </Box>
  );
}
