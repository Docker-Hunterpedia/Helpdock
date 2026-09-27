import { TextField } from '@mui/material';
import { type ReactNode, useMemo } from 'react';
import { timeZoneOptions, zoneLabel } from './hours-draft.js';

/**
 * Every IANA zone the browser knows, labelled with its current offset
 * ("Asia/Riyadh (GMT+03:00)"). A native select: four hundred options are a
 * list the platform already knows how to search by typing.
 */
export function TimeZoneSelect({
  label,
  value,
  helperText,
  disabled = false,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly helperText?: string;
  readonly disabled?: boolean;
  onChange(timezone: string): void;
}): ReactNode {
  const options = useMemo(() => {
    const zones = timeZoneOptions();
    return (zones.includes(value) ? zones : [value, ...zones]).map((zone) => ({
      zone,
      label: zoneLabel(zone),
    }));
  }, [value]);

  return (
    <TextField
      select
      size="small"
      label={label}
      value={value}
      disabled={disabled}
      helperText={helperText}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
      sx={{ maxInlineSize: 360 }}
    >
      {options.map(({ zone, label: text }) => (
        <option key={zone} value={zone}>
          {text}
        </option>
      ))}
    </TextField>
  );
}
