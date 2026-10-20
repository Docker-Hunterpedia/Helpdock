import type { SsoConnectionInput } from '@helpdock/schemas';
import { Link, MenuItem, TextField } from '@mui/material';
import { useT } from '../../../app/i18n.js';
import { AlertBanner } from '../../../ui/alert-banner.tsx';
import {
  applySsoPreset,
  SSO_PRESET_GUIDES,
  SSO_PRESET_IDS,
  type SsoPresetId,
} from './sso-presets.ts';

/**
 * Admin/Settings-SSO-M18 "Start from" select (M18-09). Picking a preset fills
 * its fields once; the choice lives only in the form and is never saved.
 */
export function SsoPresetPicker({
  draft,
  preset,
  onChange,
}: {
  draft: SsoConnectionInput;
  preset: SsoPresetId;
  onChange: (preset: SsoPresetId, draft: SsoConnectionInput) => void;
}) {
  const t = useT();
  return (
    <>
      <TextField
        select
        label={t('sso:presets.label')}
        value={preset}
        helperText={t('sso:presets.hint')}
        onChange={(event) => {
          const next = event.target.value as SsoPresetId;
          onChange(next, applySsoPreset(draft, next));
        }}
      >
        {SSO_PRESET_IDS.map((id) => (
          <MenuItem key={id} value={id}>
            {t(`sso:presets.${id}.name`)}
          </MenuItem>
        ))}
      </TextField>
      {preset === 'custom' ? null : (
        <AlertBanner tone="info">
          {t(`sso:presets.${preset}.banner`)}{' '}
          <Link href={SSO_PRESET_GUIDES[preset]} target="_blank" rel="noopener noreferrer">
            {t('sso:presets.guide')}
          </Link>
        </AlertBanner>
      )}
    </>
  );
}
