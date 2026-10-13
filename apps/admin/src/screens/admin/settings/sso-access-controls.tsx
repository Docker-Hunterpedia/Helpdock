import type { SsoConnectionInput, SsoTargets } from '@helpdock/schemas';
import { Box, MenuItem, TextField } from '@mui/material';
import { useT } from '../../../app/i18n.js';

type Access = NonNullable<SsoConnectionInput['defaultAccess']>;
export const SSO_ROLE_LABELS = {
  admin: 'staff:roles.admin',
  team_leader: 'staff:roles.teamLeader',
  agent: 'staff:roles.agent',
  viewer: 'staff:roles.viewer',
} as const;

export function SsoAccessControls({
  access,
  targets,
  onChange,
}: {
  access: Access;
  targets: SsoTargets;
  onChange: (access: Access) => void;
}) {
  const t = useT();
  const departments =
    targets.brands.find((brand) => brand.id === access.brandId)?.departments ?? [];
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(3, minmax(0, 1fr))' },
        gap: 3,
      }}
    >
      <TextField
        select
        label={t('sso:brand')}
        value={access.brandId}
        onChange={(event) =>
          onChange({
            ...access,
            brandId: event.target.value,
            departmentIds: access.role === 'agent' ? [] : null,
          })
        }
      >
        {targets.brands.map((brand) => (
          <MenuItem key={brand.id} value={brand.id}>
            {brand.name}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        label={t('sso:role')}
        value={access.role}
        onChange={(event) => {
          const role = event.target.value as Access['role'];
          onChange({
            ...access,
            role,
            departmentIds: role === 'agent' ? (access.departmentIds ?? []) : null,
          });
        }}
      >
        {Object.entries(SSO_ROLE_LABELS).map(([role, label]) => (
          <MenuItem key={role} value={role}>
            {t(label)}
          </MenuItem>
        ))}
      </TextField>
      <TextField
        select
        label={t('sso:departments')}
        value={access.departmentIds ?? ['*']}
        disabled={access.role === 'admin'}
        slotProps={{ select: { multiple: true } }}
        onChange={(event) => {
          const selected =
            typeof event.target.value === 'string'
              ? event.target.value.split(',')
              : (event.target.value as string[]);
          onChange({ ...access, departmentIds: selected.includes('*') ? null : selected });
        }}
      >
        {access.role !== 'agent' ? <MenuItem value="*">{t('sso:allDepartments')}</MenuItem> : null}
        {departments.map((department) => (
          <MenuItem key={department.id} value={department.id}>
            {department.name}
          </MenuItem>
        ))}
      </TextField>
    </Box>
  );
}
