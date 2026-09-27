import { Select, type SxProps, type Theme } from '@mui/material';
import type { ReactNode } from 'react';

/**
 * DESIGN §6.1's Select at md, as a native `<select>` in the outlined input: the
 * builder has a dozen of them in a row, and a native control is the one that
 * a keyboard, a screen reader and a phone all already know how to drive.
 */
export function Choice({
  label,
  value,
  onChange,
  children,
  id,
  disabled = false,
  sx,
}: {
  /** The accessible name, when no visible `<label>` points at `id`. */
  readonly label?: string | undefined;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly children: ReactNode;
  readonly id?: string | undefined;
  readonly disabled?: boolean;
  readonly sx?: SxProps<Theme>;
}): ReactNode {
  return (
    <Select
      native
      size="small"
      value={value}
      disabled={disabled}
      onChange={(event) => {
        onChange(String(event.target.value));
      }}
      inputProps={{
        ...(id === undefined ? {} : { id }),
        ...(label === undefined ? {} : { 'aria-label': label }),
      }}
      sx={{ minWidth: 0, ...sx }}
    >
      {children}
    </Select>
  );
}
