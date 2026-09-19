import type { Department, StaffRole } from '@helpdock/schemas';
import { Autocomplete, Box, Chip, Paper, TextField, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useT } from '../app/i18n.js';
import { useSemanticTokens } from '../app/tokens.js';

/**
 * The two fields that decide what somebody may do: the four role cards and the
 * department chips. They are shared by the invite dialog and the change-role
 * dialog, so the rule a person reads is worded once.
 *
 * The cards are radio buttons, not a select. Four options with a sentence each
 * is exactly what a select hides, and choosing a role is the decision on the
 * screen — the artboard makes them cards for that reason.
 */

export const STAFF_ROLES: readonly StaffRole[] = ['admin', 'teamLeader', 'agent', 'viewer'];

export interface RoleFieldsProps {
  readonly role: StaffRole;
  readonly departmentIds: readonly string[];
  readonly departments: readonly Department[];
  /** `roles.viewerEnabled`. Off leaves the Viewer card out entirely. */
  readonly viewerEnabled: boolean;
  readonly brandName: string;
  onRoleChange(role: StaffRole): void;
  onDepartmentsChange(departmentIds: string[]): void;
}

export function StaffRoleFields({
  role,
  departmentIds,
  departments,
  viewerEnabled,
  brandName,
  onRoleChange,
  onDepartmentsChange,
}: RoleFieldsProps): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();

  const offered = STAFF_ROLES.filter((candidate) => candidate !== 'viewer' || viewerEnabled);
  const chosen = departments.filter((department) => departmentIds.includes(department.id));

  return (
    <>
      <Box
        role="radiogroup"
        aria-label={t('staff:inviteDialog.roleLabel', { brand: brandName })}
        sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
      >
        <Typography component="span" sx={{ fontSize: 13, fontWeight: 500 }}>
          {t('staff:inviteDialog.roleLabel', { brand: brandName })}
        </Typography>

        {offered.map((candidate) => (
          <Paper
            key={candidate}
            component="label"
            elevation={0}
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 3,
              padding: 3,
              cursor: 'pointer',
              borderRadius: '8px',
              border: `1px solid ${role === candidate ? tokens['action.primary'] : tokens['border.default']}`,
              backgroundColor:
                role === candidate ? tokens['action.primary.tint'] : tokens['bg.surface'],
            }}
          >
            <input
              type="radio"
              name="staff-role"
              value={candidate}
              checked={role === candidate}
              onChange={() => {
                onRoleChange(candidate);
              }}
              style={{ marginBlockStart: 3 }}
            />
            <Box sx={{ display: 'flex', flexDirection: 'column' }}>
              <Typography variant="bodyStrong" component="span">
                {t(`staff:roles.${candidate}`)}
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t(`staff:roleDescriptions.${candidate}`)}
              </Typography>
            </Box>
          </Paper>
        ))}

        {viewerEnabled ? null : (
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('staff:inviteDialog.viewerOff')}
          </Typography>
        )}
      </Box>

      <Autocomplete
        multiple
        options={[...departments]}
        value={chosen}
        getOptionLabel={(department) => department.name}
        isOptionEqualToValue={(option, value) => option.id === value.id}
        onChange={(_event, value) => {
          onDepartmentsChange(value.map((department) => department.id));
        }}
        // An Admin sees the whole brand, so the picker would be a lie.
        disabled={role === 'admin'}
        renderValue={(value, getItemProps) =>
          value.map((department, index) => {
            const { key, ...chipProps } = getItemProps({ index });

            return <Chip key={key} size="small" label={department.name} {...chipProps} />;
          })
        }
        renderInput={(params) => (
          <TextField
            {...params}
            label={t('staff:inviteDialog.departmentsLabel')}
            placeholder={departments.length === 0 ? undefined : t('staff:departments.add')}
            helperText={role === 'admin' ? t('staff:departments.all') : t('staff:departments.hint')}
          />
        )}
      />
    </>
  );
}
