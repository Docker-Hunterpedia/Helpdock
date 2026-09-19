import type { Department, StaffMember, StaffRole } from '@helpdock/schemas';
import { staffInviteRequestSchema } from '@helpdock/schemas';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  TextField,
  Typography,
} from '@mui/material';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../app/i18n.js';
import { StaffRoleFields } from './staff-role-fields.tsx';

/**
 * The two forms on the staff screen: inviting somebody, and changing what
 * somebody already here may do. They are 520 px dialogs from `Admin/Staff`,
 * with the role cards and the department chips of `StaffRoleFields` between the
 * address and the buttons.
 *
 * Both are controlled from the screen, so a dialog holds only what the person
 * is typing and the screen holds what the server knows.
 */

export interface InviteDialogProps {
  readonly open: boolean;
  readonly departments: readonly Department[];
  readonly viewerEnabled: boolean;
  readonly brandName: string;
  readonly busy: boolean;
  onSubmit(value: { email: string; role: StaffRole; departmentIds: string[] }): void;
  onClose(): void;
}

export function InviteDialog({
  open,
  departments,
  viewerEnabled,
  brandName,
  busy,
  onSubmit,
  onClose,
}: InviteDialogProps): ReactNode {
  const t = useT();
  const emailId = useId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<StaffRole>('agent');
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // A dialog that reopens with the last invitation still in it would send the
  // next one to the wrong address on a mis-click.
  useEffect(() => {
    if (open) {
      setEmail('');
      setRole('agent');
      setDepartmentIds([]);
      setError(null);
    }
  }, [open]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();

    const address = email.trim();
    if (address === '') {
      setError(t('staff:inviteDialog.emailRequired'));
      return;
    }
    // Through the schema the request itself is validated with, so the form and
    // the api can never disagree about what an address is.
    if (!staffInviteRequestSchema.shape.email.safeParse(address).success) {
      setError(t('staff:inviteDialog.emailInvalid'));
      return;
    }

    setError(null);
    onSubmit({ email: address, role, departmentIds });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      slotProps={{ paper: { sx: { maxWidth: 520 } } }}
    >
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>
          {t('staff:inviteDialog.title')}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('staff:inviteDialog.description')}
          </Typography>

          <TextField
            id={emailId}
            type="email"
            label={t('staff:inviteDialog.emailLabel')}
            placeholder={t('staff:inviteDialog.emailPlaceholder')}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            error={error !== null}
            helperText={error ?? ' '}
            autoFocus
            slotProps={{ htmlInput: { autoComplete: 'off', maxLength: 320 } }}
          />

          <StaffRoleFields
            role={role}
            departmentIds={departmentIds}
            departments={departments}
            viewerEnabled={viewerEnabled}
            brandName={brandName}
            onRoleChange={setRole}
            onDepartmentsChange={setDepartmentIds}
          />
        </DialogContent>
        <DialogActions sx={{ padding: 4, gap: 2 }}>
          <Button variant="text" onClick={onClose} disabled={busy}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy}>
            {t('staff:inviteDialog.submit')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

export interface RoleDialogProps {
  readonly member: StaffMember | null;
  readonly departments: readonly Department[];
  readonly viewerEnabled: boolean;
  readonly brandName: string;
  readonly busy: boolean;
  onSubmit(value: { role: StaffRole; departmentIds: string[] }): void;
  onClose(): void;
}

export function RoleDialog({
  member,
  departments,
  viewerEnabled,
  brandName,
  busy,
  onSubmit,
  onClose,
}: RoleDialogProps): ReactNode {
  const t = useT();
  const [role, setRole] = useState<StaffRole>('agent');
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);

  useEffect(() => {
    if (member !== null) {
      setRole(member.role);
      setDepartmentIds(
        member.departments === 'all' ? [] : member.departments.map((department) => department.id),
      );
    }
  }, [member]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit({ role, departmentIds });
  };

  return (
    <Dialog
      open={member !== null}
      onClose={onClose}
      fullWidth
      slotProps={{ paper: { sx: { maxWidth: 520 } } }}
    >
      <Box component="form" onSubmit={submit}>
        <DialogTitle sx={{ fontSize: 16, fontWeight: 600 }}>
          {t('staff:roleDialog.title')}
        </DialogTitle>
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('staff:roleDialog.description', { name: member?.name ?? '', brand: brandName })}
          </Typography>

          <StaffRoleFields
            role={role}
            departmentIds={departmentIds}
            departments={departments}
            viewerEnabled={viewerEnabled}
            brandName={brandName}
            onRoleChange={setRole}
            onDepartmentsChange={setDepartmentIds}
          />
        </DialogContent>
        <DialogActions sx={{ padding: 4, gap: 2 }}>
          <Button variant="text" onClick={onClose} disabled={busy}>
            {t('common:actions.cancel')}
          </Button>
          <Button type="submit" variant="contained" disabled={busy}>
            {t('staff:roleDialog.submit')}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
