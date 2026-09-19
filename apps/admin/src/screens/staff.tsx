import type { StaffMember, StaffRole } from '@helpdock/schemas';
import {
  Box,
  Button,
  Chip,
  IconButton,
  InputAdornment,
  ListItemIcon,
  Menu,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EllipsisVertical,
  MailCheck,
  Search,
  ShieldUser,
  Trash2,
  UserCheck,
  UserMinus,
  UserX,
} from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../app/i18n.js';
import { useSemanticTokens } from '../app/tokens.js';
import { isAuthError } from '../auth/api.js';
import { currentBrand, useSession, useStaffApi } from '../auth/session.tsx';
import { PageHeader } from '../shell/page-header.tsx';
import { isStaffError } from '../staff/api.js';
import { ConfirmDialog } from '../ui/confirm-dialog.tsx';
import { useToast } from '../ui/toasts.tsx';
import { InviteDialog, RoleDialog } from './staff-dialogs.tsx';

/**
 * `Admin/Staff`: everyone with a role in this brand, and everything
 * DOMAIN-RULES §12 lets an administrator do to them.
 *
 * **Every mutation invalidates the list rather than patching it.** A role
 * change ends the target's sessions, a deactivation changes what other rows may
 * do, and a revoked invitation may remove an account altogether — so what comes
 * back from the server is the only thing worth drawing. The row that is being
 * acted on is disabled while its request is in flight, which is the part of
 * "optimistic" that is honest here.
 *
 * **A refusal is a toast, not a banner.** The four rules that answer no — your
 * own role, the last install admin, a department you do not lead, the Viewer
 * toggle — are about the action, not about the page, and the page behind the
 * toast is still correct.
 */

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

const daysBetween = (iso: string, now: number): number =>
  Math.round(Math.abs(now - Date.parse(iso)) / MILLIS_PER_DAY);

type RowAction = 'deactivate' | 'remove' | 'revoke';

export function StaffScreen(): ReactNode {
  const t = useT();
  const api = useStaffApi();
  const session = useSession();
  const tokens = useSemanticTokens();
  const toast = useToast();
  const queryClient = useQueryClient();
  const searchId = useId();

  const brand = currentBrand(session);
  const [search, setSearch] = useState('');
  const [menuFor, setMenuFor] = useState<{ member: StaffMember; anchor: HTMLElement } | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [roleFor, setRoleFor] = useState<StaffMember | null>(null);
  const [confirming, setConfirming] = useState<{ member: StaffMember; action: RowAction } | null>(
    null,
  );

  const staff = useQuery({
    queryKey: ['staff', brand.id, search],
    queryFn: () => api.listStaff(brand.id, search),
  });

  const departments = useQuery({
    queryKey: ['departments', brand.id],
    queryFn: () => api.departments(brand.id),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['staff', brand.id] });
  };

  const report = (error: unknown): void => {
    if (isStaffError(error)) {
      const key = {
        self: 'staff:toast.selfChange',
        'out-of-scope': 'staff:toast.outOfScope',
        'viewer-disabled': 'staff:toast.viewerDisabled',
        'last-install-admin': 'staff:toast.lastInstallAdmin',
      } as const;

      toast({ tone: 'danger', message: t(key[error.reason]) });
      return;
    }

    toast({
      tone: 'danger',
      message: isAuthError(error) ? t('auth:unavailable') : t('staff:toast.failed'),
    });
  };

  const invite = useStaffAction(
    (value: { email: string; role: StaffRole; departmentIds: string[] }) =>
      api.invite(brand.id, value),
    (value) => t('staff:toast.invited', { email: value.email }),
    refresh,
    report,
  );

  const changeRole = useStaffAction(
    (value: { member: StaffMember; role: StaffRole; departmentIds: string[] }) =>
      api.updateStaff(brand.id, value.member.userId, {
        role: value.role,
        departmentIds: value.departmentIds,
      }),
    (value) =>
      t('staff:toast.roleChanged', {
        name: value.member.name,
        role: t(`staff:roles.${value.role}`),
        brand: brand.name,
      }),
    refresh,
    report,
  );

  const setActive = useStaffAction(
    (value: { member: StaffMember; active: boolean }) =>
      api.setActive(brand.id, value.member.userId, value.active),
    (value) =>
      t(value.active ? 'staff:toast.reactivated' : 'staff:toast.deactivated', {
        name: value.member.name,
      }),
    refresh,
    report,
  );

  const remove = useStaffAction(
    (member: StaffMember) => api.removeFromBrand(brand.id, member.userId),
    (member) => t('staff:toast.removed', { name: member.name, brand: brand.name }),
    refresh,
    report,
  );

  const resend = useStaffAction(
    (member: StaffMember) => api.resendInvite(brand.id, member.userId),
    (member) => t('staff:toast.resent', { email: member.email }),
    refresh,
    report,
  );

  const revoke = useStaffAction(
    (member: StaffMember) => api.revokeInvite(brand.id, member.userId),
    (member) => t('staff:toast.revoked', { email: member.email }),
    refresh,
    report,
  );

  const busy =
    invite.isPending ||
    changeRole.isPending ||
    setActive.isPending ||
    remove.isPending ||
    resend.isPending ||
    revoke.isPending;

  const rows = staff.data?.staff ?? [];
  const viewerEnabled = staff.data?.viewerEnabled ?? true;
  const now = Date.now();

  const confirmCopy = (): { title: string; body: string; confirmLabel: string } => {
    const member = confirming?.member;
    switch (confirming?.action) {
      case 'remove':
        return {
          title: t('staff:confirm.remove.title', { name: member?.name ?? '', brand: brand.name }),
          body: t('staff:confirm.remove.body'),
          confirmLabel: t('staff:confirm.remove.submit'),
        };
      case 'revoke':
        return {
          title: t('staff:confirm.revoke.title', { email: member?.email ?? '' }),
          body: t('staff:confirm.revoke.body'),
          confirmLabel: t('staff:confirm.revoke.submit'),
        };
      case 'deactivate':
      default:
        return {
          title: t('staff:confirm.deactivate.title', { name: member?.name ?? '' }),
          body: t('staff:confirm.deactivate.body'),
          confirmLabel: t('staff:confirm.deactivate.submit'),
        };
    }
  };

  return (
    <>
      <PageHeader
        title={t('staff:title')}
        caption={t('staff:subtitle', {
          brand: brand.name,
          people: t('staff:peopleCount', { count: rows.length }),
          viewer: viewerEnabled ? t('staff:viewerEnabled') : t('staff:viewerDisabled'),
        })}
        action={
          <Button
            variant="contained"
            onClick={() => {
              setInviteOpen(true);
            }}
          >
            {t('staff:invite')}
          </Button>
        }
      />

      <TextField
        id={searchId}
        value={search}
        onChange={(event) => {
          setSearch(event.target.value);
        }}
        placeholder={t('staff:searchPlaceholder')}
        size="small"
        sx={{ marginBlockEnd: 5, width: 280 }}
        slotProps={{
          htmlInput: { 'aria-label': t('staff:searchPlaceholder') },
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <Search size={16} aria-hidden="true" />
              </InputAdornment>
            ),
          },
        }}
      />

      <TableContainer
        sx={{
          borderRadius: '10px',
          border: `1px solid ${tokens['border.default']}`,
          backgroundColor: tokens['bg.surface'],
        }}
      >
        <Table aria-label={t('staff:table.caption', { brand: brand.name })}>
          <TableHead>
            <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
              <TableCell>{t('staff:table.person')}</TableCell>
              <TableCell>{t('staff:table.role')}</TableCell>
              <TableCell>{t('staff:table.departments')}</TableCell>
              <TableCell>{t('staff:table.twoFactor')}</TableCell>
              <TableCell>{t('staff:table.lastActive')}</TableCell>
              <TableCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((member) => (
              <TableRow
                key={member.userId}
                sx={{
                  height: 44,
                  /**
                   * The artboard dims a deactivated row to 60 % opacity. That
                   * multiplies through to the caption text, which is already
                   * `text.secondary`, and takes it under the 4.5:1 of DESIGN
                   * §10 — the checklist every UI change has to tick. So the row
                   * is set back on `bg.muted` instead, which reads as inactive
                   * at a glance without making the address in it unreadable,
                   * and the state is said in words beside the name as well.
                   */
                  backgroundColor: member.status === 'deactivated' ? tokens['bg.muted'] : undefined,
                }}
              >
                <TableCell>
                  <Typography variant="bodyStrong" component="span" sx={{ display: 'block' }}>
                    {member.name}
                    {member.self ? ` · ${t('staff:table.self')}` : ''}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    <bdi>{member.email}</bdi>
                  </Typography>
                  {member.status === 'invited' && member.invitedAt !== null ? (
                    <Typography
                      variant="caption"
                      sx={{ display: 'block', color: 'text.secondary' }}
                    >
                      {t('staff:pendingInvite.line', {
                        invited: t('staff:pendingInvite.invitedAgo', {
                          count: daysBetween(member.invitedAt, now),
                        }),
                        expires: t('staff:pendingInvite.expiresIn', {
                          count:
                            member.invitationExpiresAt === null
                              ? 0
                              : daysBetween(member.invitationExpiresAt, now),
                        }),
                      })}
                    </Typography>
                  ) : null}
                  {member.status === 'deactivated' && member.deactivatedAt !== null ? (
                    <Typography
                      variant="caption"
                      sx={{ display: 'block', color: 'text.secondary' }}
                    >
                      {t('staff:status.deactivated')}
                    </Typography>
                  ) : null}
                </TableCell>
                <TableCell>
                  {member.installAdmin ? (
                    <Chip size="small" label={t('staff:installAdmin')} />
                  ) : (
                    t(`staff:roles.${member.role}`)
                  )}
                </TableCell>
                <TableCell>
                  {member.departments === 'all'
                    ? t('staff:departments.all')
                    : member.departments.length === 0
                      ? t('common:placeholder.empty')
                      : member.departments.map((department) => department.name).join(', ')}
                </TableCell>
                <TableCell>
                  {member.twoFactorEnabled
                    ? t('staff:twoFactor.enrolled')
                    : t('staff:twoFactor.pending')}
                </TableCell>
                <TableCell>
                  {member.lastActiveAt === null
                    ? t('staff:lastActive.never')
                    : new Date(member.lastActiveAt).toLocaleDateString()}
                </TableCell>
                <TableCell align="right">
                  {member.self ? null : (
                    <IconButton
                      aria-label={t('staff:table.rowActions', { name: member.name })}
                      aria-haspopup="menu"
                      disabled={busy}
                      onClick={(event) => {
                        setMenuFor({ member, anchor: event.currentTarget });
                      }}
                    >
                      <EllipsisVertical size={16} aria-hidden="true" />
                    </IconButton>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {rows.length === 0 && !staff.isPending ? (
          <Box sx={{ padding: 8, textAlign: 'center' }}>
            <Typography variant="h3" component="p">
              {search === '' ? t('staff:empty.heading') : t('staff:empty.noMatchesHeading')}
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary', marginBlockStart: 2 }}>
              {search === ''
                ? t('staff:empty.body', { brand: brand.name })
                : t('staff:empty.noMatchesBody')}
            </Typography>
          </Box>
        ) : null}
      </TableContainer>

      <Menu
        anchorEl={menuFor?.anchor ?? null}
        open={menuFor !== null}
        onClose={() => {
          setMenuFor(null);
        }}
        slotProps={{
          list: {
            'aria-label': t('staff:table.rowActions', { name: menuFor?.member.name ?? '' }),
          },
        }}
      >
        {menuFor?.member.status === 'invited'
          ? [
              <MenuItem
                key="resend"
                onClick={() => {
                  const member = menuFor.member;
                  setMenuFor(null);
                  resend.mutate(member);
                }}
              >
                <ListItemIcon>
                  <MailCheck size={16} aria-hidden="true" />
                </ListItemIcon>
                {t('staff:actions.resend')}
              </MenuItem>,
              <MenuItem
                key="revoke"
                onClick={() => {
                  setConfirming({ member: menuFor.member, action: 'revoke' });
                  setMenuFor(null);
                }}
              >
                <ListItemIcon>
                  <Trash2 size={16} aria-hidden="true" />
                </ListItemIcon>
                {t('staff:actions.revoke')}
              </MenuItem>,
            ]
          : [
              <MenuItem
                key="role"
                onClick={() => {
                  setRoleFor(menuFor?.member ?? null);
                  setMenuFor(null);
                }}
              >
                <ListItemIcon>
                  <ShieldUser size={16} aria-hidden="true" />
                </ListItemIcon>
                {t('staff:actions.changeRole')}
              </MenuItem>,
              menuFor?.member.status === 'deactivated' ? (
                <MenuItem
                  key="reactivate"
                  onClick={() => {
                    const member = menuFor.member;
                    setMenuFor(null);
                    setActive.mutate({ member, active: true });
                  }}
                >
                  <ListItemIcon>
                    <UserCheck size={16} aria-hidden="true" />
                  </ListItemIcon>
                  {t('staff:actions.reactivate')}
                </MenuItem>
              ) : (
                <MenuItem
                  key="deactivate"
                  onClick={() => {
                    if (menuFor !== null) {
                      setConfirming({ member: menuFor.member, action: 'deactivate' });
                    }
                    setMenuFor(null);
                  }}
                >
                  <ListItemIcon>
                    <UserX size={16} aria-hidden="true" />
                  </ListItemIcon>
                  {t('staff:actions.deactivate')}
                </MenuItem>
              ),
              <MenuItem
                key="remove"
                onClick={() => {
                  if (menuFor !== null) {
                    setConfirming({ member: menuFor.member, action: 'remove' });
                  }
                  setMenuFor(null);
                }}
              >
                <ListItemIcon>
                  <UserMinus size={16} aria-hidden="true" />
                </ListItemIcon>
                {t('staff:actions.remove', { brand: brand.name })}
              </MenuItem>,
            ]}
      </Menu>

      <InviteDialog
        open={inviteOpen}
        departments={departments.data?.departments ?? []}
        viewerEnabled={viewerEnabled}
        brandName={brand.name}
        busy={invite.isPending}
        onClose={() => {
          setInviteOpen(false);
        }}
        onSubmit={(value) => {
          setInviteOpen(false);
          invite.mutate(value);
        }}
      />

      <RoleDialog
        member={roleFor}
        departments={departments.data?.departments ?? []}
        viewerEnabled={viewerEnabled}
        brandName={brand.name}
        busy={changeRole.isPending}
        onClose={() => {
          setRoleFor(null);
        }}
        onSubmit={(value) => {
          const member = roleFor;
          setRoleFor(null);
          if (member !== null) {
            changeRole.mutate({ member, ...value });
          }
        }}
      />

      <ConfirmDialog
        open={confirming !== null}
        destructive
        busy={busy}
        {...confirmCopy()}
        onClose={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          const pending = confirming;
          setConfirming(null);
          if (pending === null) {
            return;
          }

          if (pending.action === 'remove') {
            remove.mutate(pending.member);
          } else if (pending.action === 'revoke') {
            revoke.mutate(pending.member);
          } else {
            setActive.mutate({ member: pending.member, active: false });
          }
        }}
      />
    </>
  );
}

/**
 * One row action: run it, re-read the list, say what happened. Every mutation
 * on this screen has that shape, and the difference between them is a request
 * and a sentence — so the shape lives here and each call site is three lines.
 *
 * The list is invalidated rather than patched. A role change ends the target's
 * sessions, a deactivation changes what other rows may do, and a revoked
 * invitation may remove an account altogether; what the server sends back is
 * the only version worth drawing.
 */
function useStaffAction<TInput>(
  run: (input: TInput) => Promise<unknown>,
  message: (input: TInput) => string,
  refresh: () => Promise<void>,
  report: (error: unknown) => void,
) {
  const toast = useToast();

  return useMutation({
    mutationFn: run,
    onSuccess: async (_result: unknown, input: TInput) => {
      await refresh();
      toast({ tone: 'success', message: message(input) });
    },
    onError: report,
  });
}
