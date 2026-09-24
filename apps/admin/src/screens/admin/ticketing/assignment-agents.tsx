import type { AssignmentAgent, AssignmentAgentUpdateRequest, Tag } from '@helpdock/schemas';
import {
  Avatar,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  Menu,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { Plus, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { PresenceDot } from '../../../ui/presence-dot.tsx';
import { initialsOf } from '../../contacts/format.js';
import { TagChip } from './tag-chip.tsx';

/**
 * "Agents in <department>" (`Admin/Ticketing-Assignment`): everybody who can
 * work the department, whether they are in rotation, their skills as tags, and
 * how loaded they are against the department's cap.
 *
 * A row the viewer may not change — a Team Leader looking at an Admin — draws
 * the same facts with the controls disabled, rather than hiding the person:
 * who is in the rotation is something a Team Leader needs to see even where
 * they cannot change it.
 */

/** Whether an agent's count is at or over the cap, which the row draws in danger. */
export const atCap = (openCount: number, loadCap: number | null): boolean =>
  loadCap !== null && openCount >= loadCap;

export function AssignmentAgents({
  departmentName,
  loadCap,
  agents,
  tags,
  busy,
  onChange,
}: {
  readonly departmentName: string;
  readonly loadCap: number | null;
  readonly agents: readonly AssignmentAgent[];
  /** The brand's tags, which are what a skill can be. */
  readonly tags: readonly Tag[];
  readonly busy: boolean;
  onChange(agent: AssignmentAgent, request: AssignmentAgentUpdateRequest): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const headingId = useId();
  const [adding, setAdding] = useState<{ agent: AssignmentAgent; anchor: HTMLElement } | null>(
    null,
  );

  const offered =
    adding === null
      ? []
      : tags.filter((tag) => !adding.agent.skills.some((skill) => skill.id === tag.id));

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        overflow: 'hidden',
      }}
    >
      <Box sx={{ paddingBlock: 3, paddingInline: 4 }}>
        <Typography id={headingId} variant="h3" component="h3">
          {t('ticketing:assignment.agents.heading', { department: departmentName })}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('ticketing:assignment.agents.caption')}
        </Typography>
      </Box>

      {agents.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            paddingInline: 4,
            paddingBlockEnd: 4,
            color: 'text.secondary',
          }}
        >
          {t('ticketing:assignment.agents.empty')}
        </Typography>
      ) : (
        <TableContainer sx={{ borderBlockStart: `1px solid ${tokens['border.default']}` }}>
          <Table
            aria-label={t('ticketing:assignment.agents.tableCaption', {
              department: departmentName,
            })}
          >
            <TableHead>
              <TableRow sx={{ backgroundColor: tokens['bg.muted'] }}>
                <TableCell>{t('ticketing:assignment.agents.name')}</TableCell>
                <TableCell>{t('ticketing:assignment.agents.presence')}</TableCell>
                <TableCell>{t('ticketing:assignment.agents.load')}</TableCell>
                <TableCell>{t('ticketing:assignment.agents.skills')}</TableCell>
                <TableCell>{t('ticketing:assignment.agents.rotation')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {agents.map((agent) => {
                const full = atCap(agent.openCount, loadCap);
                const locked = busy || !agent.editable;

                return (
                  <TableRow key={agent.userId} sx={{ height: 52 }}>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <Avatar
                          aria-hidden="true"
                          sx={{
                            width: 28,
                            height: 28,
                            fontSize: 12,
                            fontWeight: 600,
                            backgroundColor: tokens['action.primary.tint'],
                            color: tokens['text.primary'],
                          }}
                        >
                          {initialsOf(agent.name)}
                        </Avatar>
                        <Typography variant="bodyStrong" component="span">
                          {agent.name}
                        </Typography>
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Box
                        component="span"
                        sx={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}
                      >
                        <PresenceDot status={agent.presence} />
                        <Typography variant="caption" component="span">
                          {t(`admin:presence.status.${agent.presence}`)}
                        </Typography>
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="mono"
                        component="span"
                        sx={{
                          fontSize: 13,
                          color: full ? tokens['status.danger.text'] : tokens['text.primary'],
                        }}
                      >
                        {loadCap === null
                          ? agent.openCount
                          : t(
                              full
                                ? 'ticketing:assignment.agents.atCap'
                                : 'ticketing:assignment.agents.loadOf',
                              { open: agent.openCount, cap: loadCap },
                            )}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
                        {agent.skills.map((skill) => (
                          <Box
                            key={skill.id}
                            component="span"
                            sx={{ display: 'inline-flex', alignItems: 'center' }}
                          >
                            <TagChip tag={skill} />
                            {agent.editable ? (
                              <IconButton
                                size="small"
                                disabled={locked}
                                aria-label={t('ticketing:assignment.agents.removeSkill', {
                                  skill: skill.name,
                                  name: agent.name,
                                })}
                                onClick={() => {
                                  onChange(agent, {
                                    skillTagIds: agent.skills
                                      .filter((other) => other.id !== skill.id)
                                      .map((other) => other.id),
                                  });
                                }}
                                sx={{ inlineSize: 28, blockSize: 28 }}
                              >
                                <X size={14} aria-hidden="true" />
                              </IconButton>
                            ) : null}
                          </Box>
                        ))}
                        {agent.editable ? (
                          <Button
                            size="small"
                            variant="text"
                            disabled={locked}
                            aria-label={t('ticketing:assignment.agents.addSkillFor', {
                              name: agent.name,
                            })}
                            aria-haspopup="menu"
                            startIcon={<Plus size={12} aria-hidden="true" />}
                            onClick={(event) => {
                              setAdding({ agent, anchor: event.currentTarget });
                            }}
                            sx={{
                              minBlockSize: 28,
                              paddingInline: 2,
                              border: `1px dashed ${tokens['border.strong']}`,
                              color: 'text.secondary',
                              fontSize: 12,
                            }}
                          >
                            {t('ticketing:assignment.agents.addSkill')}
                          </Button>
                        ) : null}
                      </Box>
                    </TableCell>
                    <TableCell>
                      <FormControlLabel
                        sx={{ marginInline: 0, gap: 1 }}
                        control={
                          <Checkbox
                            checked={agent.inRotation}
                            disabled={locked}
                            onChange={(event) => {
                              onChange(agent, { inRotation: event.target.checked });
                            }}
                            slotProps={{
                              input: {
                                'aria-label': t('ticketing:assignment.agents.inRotationFor', {
                                  name: agent.name,
                                }),
                              },
                            }}
                          />
                        }
                        label={t('ticketing:assignment.agents.inRotation')}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Menu
        anchorEl={adding?.anchor ?? null}
        open={adding !== null}
        onClose={() => {
          setAdding(null);
        }}
        slotProps={{
          list: {
            'aria-label': t('ticketing:assignment.agents.addSkillFor', {
              name: adding?.agent.name ?? '',
            }),
          },
        }}
      >
        {offered.length === 0 ? (
          <MenuItem disabled>{t('ticketing:assignment.agents.noTagsLeft')}</MenuItem>
        ) : (
          offered.map((tag) => (
            <MenuItem
              key={tag.id}
              onClick={() => {
                if (adding !== null) {
                  onChange(adding.agent, {
                    skillTagIds: [...adding.agent.skills.map((skill) => skill.id), tag.id],
                  });
                }
                setAdding(null);
              }}
            >
              <TagLabel tag={tag} />
            </MenuItem>
          ))
        )}
      </Menu>
    </Box>
  );
}

/** A tag's name in the viewer's language, for the menu. */
function TagLabel({ tag }: { readonly tag: Tag }): ReactNode {
  const { locale } = usePreferences();

  return locale === 'ar' && tag.nameAr !== null ? tag.nameAr : tag.name;
}
