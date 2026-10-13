import type { SsoMapping, SsoTargets } from '@helpdock/schemas';
import {
  Box,
  Button,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useT } from '../../../app/i18n.js';
import { SectionCard } from '../channels/section-card.tsx';
import { SsoAccessControls } from './sso-access-controls.tsx';

export type SsoMappingDraft = SsoMapping & { readonly rowKey: string };

export function SsoMappings({
  mappings,
  targets,
  onChange,
}: {
  mappings: SsoMappingDraft[];
  targets: SsoTargets;
  onChange: (mappings: SsoMappingDraft[]) => void;
}) {
  const t = useT();
  const replace = (index: number, row: SsoMappingDraft) =>
    onChange(mappings.map((mapping, position) => (position === index ? row : mapping)));
  const move = (index: number, direction: number) => {
    const reordered = [...mappings];
    const adjacent = reordered[index + direction];
    const current = reordered[index];
    if (!adjacent || !current) return;
    reordered[index] = adjacent;
    reordered[index + direction] = current;
    onChange(reordered.map((mapping, position) => ({ ...mapping, position })));
  };
  return (
    <SectionCard id="sso-mappings" heading={t('sso:mappings')} caption={t('sso:mappingsHint')}>
      <TableContainer>
        <Table aria-label={t('sso:mappings')}>
          <TableHead>
            <TableRow>
              <TableCell>{t('sso:group')}</TableCell>
              <TableCell colSpan={3}>
                {t('sso:brand')} · {t('sso:role')} · {t('sso:departments')}
              </TableCell>
              <TableCell>{t('sso:mappingActions')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {mappings.map((mapping, index) => (
              <TableRow key={mapping.rowKey}>
                <TableCell>
                  <TextField
                    label={t('sso:group')}
                    value={mapping.idpGroup}
                    onChange={(event) =>
                      replace(index, { ...mapping, idpGroup: event.target.value })
                    }
                    fullWidth
                    slotProps={{ htmlInput: { maxLength: 300, dir: 'ltr' } }}
                  />
                </TableCell>
                <TableCell colSpan={3}>
                  <SsoAccessControls
                    access={mapping}
                    targets={targets}
                    onChange={(access) => replace(index, { ...mapping, ...access })}
                  />
                </TableCell>
                <TableCell>
                  <Box sx={{ display: 'flex', gap: 2 }}>
                    <IconButton
                      aria-label={t('sso:moveUp')}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp size={16} aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      aria-label={t('sso:moveDown')}
                      disabled={index === mappings.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown size={16} aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      aria-label={t('sso:remove')}
                      onClick={() =>
                        onChange(
                          mappings
                            .filter((_mapping, position) => position !== index)
                            .map((row, position) => ({ ...row, position })),
                        )
                      }
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </IconButton>
                  </Box>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {mappings.length === 0 ? <Typography variant="caption">{t('sso:deny')}</Typography> : null}
      <Button
        startIcon={<Plus size={16} aria-hidden="true" />}
        disabled={targets.brands.length === 0 || mappings.length >= 1000}
        onClick={() => {
          const first = targets.brands[0];
          if (first)
            onChange([
              ...mappings,
              {
                rowKey: crypto.randomUUID(),
                idpGroup: '',
                brandId: first.id,
                role: 'viewer',
                departmentIds: null,
                position: mappings.length,
              },
            ]);
        }}
      >
        {t('sso:addMapping')}
      </Button>
    </SectionCard>
  );
}
