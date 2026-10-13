import type { MetaPlatform } from '@helpdock/schemas';
import { Box, MenuItem, Select } from '@mui/material';
import { type ReactNode, useId } from 'react';
import { useT } from '../../../../app/i18n.js';
import { usePreferences } from '../../../../app/providers.tsx';
import { Field } from '../../../../ui/field.tsx';
import { FormSection } from '../telegram/form-section.tsx';

interface DepartmentOption {
  readonly id: string;
  readonly name: string;
  readonly nameAr: string | null;
}

/**
 * Routing (M10-07): the department a new conversation with this account opens
 * its ticket in. A customer's next message continues their open ticket
 * wherever it is, so the choice applies from the next new conversation.
 */
export function RoutingSection({
  platform,
  departments,
  departmentId,
  onChange,
}: {
  readonly platform: MetaPlatform;
  readonly departments: readonly DepartmentOption[];
  readonly departmentId: string;
  onChange(departmentId: string): void;
}): ReactNode {
  const t = useT();
  const { locale } = usePreferences();
  const id = useId();
  const nameOf = (option: DepartmentOption): string =>
    (locale === 'ar' ? option.nameAr : null) ?? option.name;

  return (
    <FormSection
      heading={t('channels:meta.detail.routing.heading')}
      caption={t(`channels:meta.detail.routing.caption.${platform}`)}
    >
      <Box sx={{ maxWidth: 320 }}>
        <Field
          id={id}
          label={t('channels:meta.detail.routing.department')}
          hint={t('channels:meta.detail.routing.hint')}
        >
          <Select
            id={id}
            size="small"
            value={departmentId}
            fullWidth
            onChange={(event) => {
              onChange(String(event.target.value));
            }}
            inputProps={{ 'aria-label': t('channels:meta.detail.routing.department') }}
          >
            {departments.map((department) => (
              <MenuItem key={department.id} value={department.id}>
                {nameOf(department)}
              </MenuItem>
            ))}
          </Select>
        </Field>
      </Box>
    </FormSection>
  );
}
