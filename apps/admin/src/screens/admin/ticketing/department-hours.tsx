import type { BusinessHours, DepartmentHours } from '@helpdock/schemas';
import {
  Box,
  Button,
  FormControlLabel,
  IconButton,
  Radio,
  RadioGroup,
  Typography,
} from '@mui/material';
import { ChevronUp } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useT } from '../../../app/i18n.js';
import { usePreferences } from '../../../app/providers.tsx';
import { useSemanticTokens } from '../../../app/tokens.js';
import { summarizeWeek, WEEKDAY_KEYS } from './hours-draft.js';
import { TimeZoneSelect } from './time-zone-select.tsx';
import { WeekEditor } from './week-editor.tsx';

/**
 * The Department hours card (M3-01): every department on one row, following
 * the brand's hours until somebody overrides them. An overridden department
 * opens in place with its own zone and week; "Use the brand's hours" puts it
 * back. A ticket's clocks follow its department (DOMAIN-RULES §3.1).
 */
export function DepartmentHoursCard({
  departments,
  overrides,
  brand,
  expanded,
  onExpand,
  onChange,
}: {
  readonly departments: readonly DepartmentHours[];
  readonly overrides: Readonly<Record<string, BusinessHours | null>>;
  readonly brand: BusinessHours;
  readonly expanded: string | null;
  onExpand(departmentId: string | null): void;
  onChange(departmentId: string, override: BusinessHours | null): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const { locale } = usePreferences();
  const shortDay = (day: number): string =>
    t(`ticketing:businessHours.daysShort.${WEEKDAY_KEYS[day] ?? 'sunday'}`);
  const summary = (hours: BusinessHours): string =>
    summarizeWeek(hours.weekly, shortDay) ?? t('ticketing:businessHours.departments.customHours');

  return (
    <Box
      component="section"
      aria-labelledby="department-hours-heading"
      sx={{
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        overflow: 'hidden',
      }}
    >
      <Box sx={{ padding: 4 }}>
        <Typography variant="bodyStrong" component="h3" id="department-hours-heading">
          {t('ticketing:businessHours.departments.heading')}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {t('ticketing:businessHours.departments.caption')}
        </Typography>
      </Box>

      {departments.map((department) => {
        const name = (locale === 'ar' ? department.nameAr : null) ?? department.name;
        const override = overrides[department.departmentId] ?? null;
        const open = expanded === department.departmentId;

        return open ? (
          <OverrideEditor
            key={department.departmentId}
            name={name}
            override={override}
            brand={brand}
            onCollapse={() => {
              onExpand(null);
            }}
            onChange={(next) => {
              onChange(department.departmentId, next);
            }}
          />
        ) : (
          <Box
            key={department.departmentId}
            sx={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 120px) minmax(0, 1fr) auto',
              alignItems: 'center',
              gap: 2,
              minBlockSize: 44,
              paddingInline: 4,
              borderBlockStart: `1px solid ${tokens['border.default']}`,
            }}
          >
            <Typography variant="body2">{name}</Typography>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              <bdi>
                {override === null
                  ? t('ticketing:businessHours.departments.brandHours', { summary: summary(brand) })
                  : t('ticketing:businessHours.departments.ownHoursSummary', {
                      summary: summary(override),
                    })}
              </bdi>
            </Typography>
            <Button
              variant="text"
              size="small"
              aria-label={t('ticketing:businessHours.departments.overrideFor', { name })}
              onClick={() => {
                onExpand(department.departmentId);
              }}
            >
              {override === null
                ? t('ticketing:businessHours.departments.override')
                : t('ticketing:businessHours.departments.edit')}
            </Button>
          </Box>
        );
      })}
    </Box>
  );
}

function OverrideEditor({
  name,
  override,
  brand,
  onCollapse,
  onChange,
}: {
  readonly name: string;
  readonly override: BusinessHours | null;
  readonly brand: BusinessHours;
  onCollapse(): void;
  onChange(override: BusinessHours | null): void;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const legend = useId();
  const own = override !== null;

  return (
    <Box
      sx={{
        paddingBlock: 3,
        paddingInline: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        borderBlockStart: `1px solid ${tokens['border.default']}`,
        borderInlineStart: `3px solid ${tokens['action.primary']}`,
        backgroundColor: tokens['action.primary.tint'],
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography variant="bodyStrong" component="h4">
          {name}
        </Typography>
        {own ? (
          <Typography
            variant="caption"
            sx={{
              paddingInline: 1.5,
              borderRadius: '6px',
              backgroundColor: tokens['bg.muted'],
              color: 'text.secondary',
            }}
          >
            {t('ticketing:businessHours.departments.ownHours')}
          </Typography>
        ) : null}
        <IconButton
          size="small"
          sx={{ marginInlineStart: 'auto' }}
          aria-label={t('ticketing:businessHours.departments.collapse', { name })}
          onClick={onCollapse}
        >
          <ChevronUp size={16} aria-hidden="true" />
        </IconButton>
      </Box>

      <Box component="fieldset" sx={{ border: 0, margin: 0, padding: 0 }}>
        <Typography component="legend" variant="body2" id={legend} sx={{ fontWeight: 500 }}>
          {t('ticketing:businessHours.departments.legend', { name })}
        </Typography>
        <RadioGroup
          aria-labelledby={legend}
          value={own ? 'own' : 'brand'}
          onChange={(event) => {
            onChange(
              event.target.value === 'own'
                ? { timezone: brand.timezone, weekly: brand.weekly.map((ranges) => [...ranges]) }
                : null,
            );
          }}
        >
          <FormControlLabel
            value="brand"
            control={<Radio size="small" />}
            label={t('ticketing:businessHours.departments.useBrand')}
          />
          <FormControlLabel
            value="own"
            control={<Radio size="small" />}
            label={t('ticketing:businessHours.departments.useOwn')}
          />
        </RadioGroup>
      </Box>

      {override === null ? null : (
        <>
          <TimeZoneSelect
            label={t('ticketing:businessHours.departments.timezone')}
            value={override.timezone}
            onChange={(timezone) => {
              onChange({ ...override, timezone });
            }}
          />
          <Box
            sx={{
              borderRadius: '8px',
              border: `1px solid ${tokens['border.default']}`,
              backgroundColor: tokens['bg.surface'],
              overflow: 'hidden',
              '& > ul > li:first-of-type': { borderBlockStart: 0 },
            }}
          >
            <WeekEditor
              weekly={override.weekly}
              showStateLabel={false}
              onChange={(weekly) => {
                onChange({ ...override, weekly });
              }}
            />
          </Box>
        </>
      )}

      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {t('ticketing:businessHours.departments.note', { name })}
      </Typography>
    </Box>
  );
}
