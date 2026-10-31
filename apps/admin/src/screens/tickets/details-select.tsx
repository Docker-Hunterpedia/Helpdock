import { Box, TextField, Typography } from '@mui/material';
import { type ComponentProps, type ReactNode, useId } from 'react';

/**
 * A select of the details panel with its label **above** it (M14-20,
 * `Admin/Ticket-Details-Order`), in the same 12 px caption the assignee picker
 * and the tags use. The notched label MUI floats on the border is not drawn:
 * four of them stacked in a 300 px panel read as noise next to the two that
 * were already above.
 *
 * The caption names the control for a screen reader (`aria-labelledby` on the
 * select's button), so `getByLabelText("Status")` finds it as it did.
 */
export function DetailsSelect({
  id,
  label,
  children,
  slotProps,
  ...rest
}: Omit<ComponentProps<typeof TextField>, 'label' | 'select' | 'size' | 'variant'> & {
  readonly id: string;
  readonly label: string;
}): ReactNode {
  const labelId = useId();
  const select = slotProps?.select;

  return (
    <Box>
      <Typography
        id={labelId}
        variant="caption"
        component="span"
        sx={{ display: 'block', color: 'text.secondary', marginBlockEnd: 1 }}
      >
        {label}
      </Typography>
      <TextField
        {...rest}
        id={id}
        select
        size="small"
        fullWidth
        slotProps={{ ...slotProps, select: { ...(select as object), labelId } }}
      >
        {children}
      </TextField>
    </Box>
  );
}
