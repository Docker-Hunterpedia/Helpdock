import type { BusinessHoursOverview, HolidayCreateRequest } from '@helpdock/schemas';
import { Box, Button, IconButton, MenuItem, TextField, Typography } from '@mui/material';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { holidayDates } from './hours-draft.js';

/**
 * The Holidays card of the Business hours tab (M3-01): an add form and the
 * brand's holidays, oldest first. A holiday is saved the moment it is added
 * and gone the moment it is deleted — it is one fact, not part of the week's
 * draft — and each save recomputes the clocks it touches on the api.
 */
export function HolidaysCard({
  overview,
  today,
  busy,
  onAdd,
  onDelete,
}: {
  readonly overview: BusinessHoursOverview;
  /** `YYYY-MM-DD`, for the "past" label. */
  readonly today: string;
  readonly busy: boolean;
  onAdd(request: HolidayCreateRequest): Promise<void>;
  onDelete(holidayId: string, name: string): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);

  const nameMissing = name.trim() === '';
  const departmentName = (id: string | null): string => {
    if (id === null) {
      return t('ticketing:businessHours.holidays.allDepartments');
    }
    const department = overview.departments.find((row) => row.departmentId === id);
    return (locale === 'ar' ? department?.nameAr : null) ?? department?.name ?? '';
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setTried(true);
    if (nameMissing || startsOn === '') {
      return;
    }
    await onAdd({
      name: name.trim(),
      startsOn,
      ...(endsOn === '' ? {} : { endsOn }),
      departmentId: departmentId === '' ? null : departmentId,
    });
    setName('');
    setEndsOn('');
    setTried(false);
  };

  const column = { xs: '1fr', sm: '140px minmax(0, 1fr) minmax(0, 160px) 40px' };

  return (
    <Box
      component="section"
      aria-labelledby="holidays-heading"
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
      }}
    >
      <Box sx={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box>
          <Typography variant="bodyStrong" component="h3" id="holidays-heading">
            {t('ticketing:businessHours.holidays.heading')}
          </Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            {t('ticketing:businessHours.holidays.caption')}
          </Typography>
        </Box>

        <Box
          component="form"
          noValidate
          aria-label={t('ticketing:businessHours.holidays.form')}
          onSubmit={(event) => {
            void submit(event);
          }}
          sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
            <TextField
              type="date"
              size="small"
              label={t('ticketing:businessHours.holidays.from')}
              value={startsOn}
              onChange={(event) => {
                setStartsOn(event.target.value);
              }}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              type="date"
              size="small"
              label={`${t('ticketing:businessHours.holidays.to')} ${t('ticketing:businessHours.holidays.optional')}`}
              value={endsOn}
              onChange={(event) => {
                setEndsOn(event.target.value);
              }}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              select
              size="small"
              label={t('ticketing:businessHours.holidays.appliesTo')}
              value={departmentId}
              onChange={(event) => {
                setDepartmentId(event.target.value);
              }}
              sx={{ minInlineSize: 180 }}
              slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
            >
              <MenuItem value="">{t('ticketing:businessHours.holidays.allDepartments')}</MenuItem>
              {overview.departments.map((department) => (
                <MenuItem key={department.departmentId} value={department.departmentId}>
                  {departmentName(department.departmentId)}
                </MenuItem>
              ))}
            </TextField>
          </Box>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
            <TextField
              size="small"
              fullWidth
              label={`${t('ticketing:businessHours.holidays.name')} ${t('ticketing:businessHours.holidays.required')}`}
              value={name}
              error={tried && nameMissing}
              helperText={
                tried && nameMissing ? t('ticketing:businessHours.holidays.nameMissing') : undefined
              }
              onChange={(event) => {
                setName(event.target.value);
              }}
              slotProps={{ htmlInput: { maxLength: 120 } }}
            />
            <Button
              type="submit"
              variant="outlined"
              disabled={busy}
              startIcon={<Plus size={16} aria-hidden="true" />}
              sx={{ flexShrink: 0 }}
            >
              {t('ticketing:businessHours.holidays.add')}
            </Button>
          </Box>
        </Box>
      </Box>

      <Box role="table" aria-label={t('ticketing:businessHours.holidays.heading')}>
        <Box
          role="row"
          sx={{
            display: 'grid',
            gridTemplateColumns: column,
            gap: 2,
            paddingInline: 4,
            paddingBlock: 2,
            backgroundColor: tokens['bg.muted'],
          }}
        >
          <Typography role="columnheader" variant="caption" sx={{ color: 'text.secondary' }}>
            {t('ticketing:businessHours.holidays.date')}
          </Typography>
          <Typography role="columnheader" variant="caption" sx={{ color: 'text.secondary' }}>
            {t('ticketing:businessHours.holidays.name')}
          </Typography>
          <Typography role="columnheader" variant="caption" sx={{ color: 'text.secondary' }}>
            {t('ticketing:businessHours.holidays.appliesTo')}
          </Typography>
          <Box role="columnheader" />
        </Box>
        {overview.holidays.length === 0 ? (
          <Typography variant="body2" sx={{ padding: 4, color: 'text.secondary' }}>
            {t('ticketing:businessHours.holidays.empty')}
          </Typography>
        ) : (
          overview.holidays.map((holiday) => (
            <Box
              role="row"
              key={holiday.id}
              sx={{
                display: 'grid',
                gridTemplateColumns: column,
                gap: 2,
                alignItems: 'center',
                minBlockSize: 44,
                paddingInline: 4,
                borderBlockStart: `1px solid ${tokens['border.default']}`,
              }}
            >
              <Typography role="cell" variant="mono">
                <bdi>{holidayDates(holiday.startsOn, holiday.endsOn, locale)}</bdi>
              </Typography>
              <Box role="cell" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="body2">{holiday.name}</Typography>
                {holiday.endsOn < today ? (
                  <Typography
                    variant="caption"
                    sx={{
                      paddingInline: 1.5,
                      borderRadius: '6px',
                      backgroundColor: tokens['bg.muted'],
                      color: 'text.secondary',
                    }}
                  >
                    {t('ticketing:businessHours.holidays.past')}
                  </Typography>
                ) : null}
              </Box>
              <Typography role="cell" variant="body2">
                {departmentName(holiday.departmentId)}
              </Typography>
              <Box role="cell">
                <IconButton
                  size="small"
                  disabled={busy}
                  aria-label={t('ticketing:businessHours.holidays.delete', { name: holiday.name })}
                  onClick={() => {
                    onDelete(holiday.id, holiday.name);
                  }}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </IconButton>
              </Box>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
