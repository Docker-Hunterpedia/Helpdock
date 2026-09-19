import type { DepartmentSummary, EligibleMember, Team, TeamMember } from '@helpdock/schemas';
import { TEAM_NAME_MAX_LENGTH } from '@helpdock/schemas';
import {
  Box,
  Button,
  Chip,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Select,
  TextField,
  Typography,
} from '@mui/material';
import { EllipsisVertical, Pencil, Trash2, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { useSemanticTokens } from '../../../app/tokens.js';

/**
 * The Teams section of the selected department, inline under the list.
 *
 * It sits in the main column rather than the side card because a team carries
 * its members, and a people picker in a 300 px column would be a scrollbar.
 * Everything in it acts on one department, so it disappears when nothing is
 * selected.
 *
 * The people picker only ever offers `eligible`: the api answers with staff
 * whose own department scope reaches this department, so a team can never hold
 * somebody who cannot see the tickets it would be assigned (DOMAIN-RULES §1.2).
 */
export function DepartmentTeams({
  department,
  teams,
  eligible,
  busy,
  onCreate,
  onRename,
  onDelete,
  onAddMember,
  onRemoveMember,
}: {
  readonly department: DepartmentSummary;
  readonly teams: readonly Team[];
  readonly eligible: readonly EligibleMember[];
  readonly busy: boolean;
  onCreate(name: string): void;
  onRename(team: Team, name: string): void;
  onDelete(team: Team): void;
  onAddMember(team: Team, userId: string): void;
  onRemoveMember(team: Team, member: TeamMember): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const newTeamId = useId();

  const [newTeam, setNewTeam] = useState('');
  const [menuFor, setMenuFor] = useState<{ team: Team; anchor: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<{ team: Team; name: string } | null>(null);

  const addTeam = (event: FormEvent): void => {
    event.preventDefault();
    if (newTeam.trim() === '') {
      return;
    }

    onCreate(newTeam.trim());
    setNewTeam('');
  };

  return (
    <Box
      sx={{
        marginBlockStart: 6,
        padding: 5,
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Typography variant="h3" component="h2" sx={{ marginBlockEnd: 4 }}>
        {t('ticketing:departments.teams.heading', { name: department.name })}
      </Typography>

      <Box component="form" onSubmit={addTeam} sx={{ display: 'flex', gap: 2, marginBlockEnd: 5 }}>
        <TextField
          id={newTeamId}
          value={newTeam}
          onChange={(event) => {
            setNewTeam(event.target.value);
          }}
          size="small"
          placeholder={t('ticketing:departments.teams.namePlaceholder')}
          slotProps={{
            htmlInput: {
              maxLength: TEAM_NAME_MAX_LENGTH,
              'aria-label': t('ticketing:departments.teams.namePlaceholder'),
            },
          }}
        />
        <Button type="submit" variant="outlined" disabled={busy || newTeam.trim() === ''}>
          {t('ticketing:departments.teams.add')}
        </Button>
      </Box>

      {teams.length === 0 ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('ticketing:departments.teams.empty')}
        </Typography>
      ) : (
        <Box component="ul" sx={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {teams.map((team) => (
            <Box
              component="li"
              key={team.id}
              sx={{
                paddingBlock: 4,
                borderBlockStart: `1px solid ${tokens['border.default']}`,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                {renaming?.team.id === team.id ? (
                  <Box
                    component="form"
                    aria-label={t('ticketing:departments.teams.renameLabel', { name: team.name })}
                    sx={{ display: 'flex', gap: 2, flex: 1 }}
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (renaming.name.trim() !== '') {
                        onRename(team, renaming.name.trim());
                        setRenaming(null);
                      }
                    }}
                  >
                    <TextField
                      value={renaming.name}
                      onChange={(event) => {
                        setRenaming({ team, name: event.target.value });
                      }}
                      size="small"
                      autoFocus
                      slotProps={{
                        htmlInput: {
                          maxLength: TEAM_NAME_MAX_LENGTH,
                          'aria-label': t('ticketing:departments.teams.renameLabel', {
                            name: team.name,
                          }),
                        },
                      }}
                    />
                    <Button type="submit" variant="outlined" disabled={busy}>
                      {t('ticketing:departments.teams.save')}
                    </Button>
                    <Button
                      variant="text"
                      onClick={() => {
                        setRenaming(null);
                      }}
                    >
                      {t('common:actions.cancel')}
                    </Button>
                  </Box>
                ) : (
                  <Typography variant="bodyStrong" component="span" sx={{ flex: 1 }}>
                    {team.name}
                  </Typography>
                )}

                <IconButton
                  aria-label={t('ticketing:departments.teams.rowActions', { name: team.name })}
                  aria-haspopup="menu"
                  disabled={busy}
                  onClick={(event) => {
                    setMenuFor({ team, anchor: event.currentTarget });
                  }}
                >
                  <EllipsisVertical size={16} aria-hidden="true" />
                </IconButton>
              </Box>

              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 2,
                  marginBlockStart: 3,
                }}
              >
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  {t('ticketing:departments.teams.members')}
                </Typography>
                {team.members.length === 0 ? (
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                    {t('ticketing:departments.teams.noMembers')}
                  </Typography>
                ) : (
                  team.members.map((member) => (
                    // A chip beside a real button rather than MUI's own delete
                    // icon: that icon is an svg with a click handler, and
                    // DESIGN §10 wants every interactive element reachable by
                    // Tab with a label a screen reader can read.
                    <Box key={member.userId} sx={{ display: 'flex', alignItems: 'center' }}>
                      <Chip size="small" label={member.name} />
                      <IconButton
                        size="small"
                        aria-label={t('ticketing:departments.teams.removeMember', {
                          name: member.name,
                          team: team.name,
                        })}
                        disabled={busy}
                        onClick={() => {
                          onRemoveMember(team, member);
                        }}
                      >
                        <X size={14} aria-hidden="true" />
                      </IconButton>
                    </Box>
                  ))
                )}

                <Select
                  value=""
                  size="small"
                  displayEmpty
                  disabled={busy}
                  onChange={(event) => {
                    if (event.target.value !== '') {
                      onAddMember(team, event.target.value);
                    }
                  }}
                  inputProps={{
                    'aria-label': t('ticketing:departments.teams.picker', { team: team.name }),
                  }}
                  sx={{ minWidth: 180 }}
                  renderValue={() => t('ticketing:departments.teams.addMember')}
                >
                  {eligible
                    .filter(
                      (candidate) =>
                        !team.members.some((member) => member.userId === candidate.userId),
                    )
                    .map((candidate) => (
                      <MenuItem key={candidate.userId} value={candidate.userId}>
                        {candidate.name}
                      </MenuItem>
                    ))}
                </Select>
              </Box>
            </Box>
          ))}
        </Box>
      )}

      <Menu
        anchorEl={menuFor?.anchor ?? null}
        open={menuFor !== null}
        onClose={() => {
          setMenuFor(null);
        }}
        slotProps={{
          list: {
            'aria-label': t('ticketing:departments.teams.rowActions', {
              name: menuFor?.team.name ?? '',
            }),
          },
        }}
      >
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              setRenaming({ team: menuFor.team, name: menuFor.team.name });
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Pencil size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:departments.teams.rename')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (menuFor !== null) {
              onDelete(menuFor.team);
            }
            setMenuFor(null);
          }}
        >
          <ListItemIcon>
            <Trash2 size={16} aria-hidden="true" />
          </ListItemIcon>
          {t('ticketing:departments.teams.delete')}
        </MenuItem>
      </Menu>
    </Box>
  );
}
