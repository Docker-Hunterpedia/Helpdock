import { Box, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { ReactNode } from 'react';

/**
 * The DESIGN §6.5 table a ChartCard's "Table" swaps in, and the body of the
 * cards that are tables to begin with (agents, searches). Numbers are mono and
 * end-aligned so a column of them can be read down.
 */

export interface Column {
  readonly key: string;
  readonly label: string;
  readonly numeric?: boolean;
}

export type Row = Readonly<Record<string, ReactNode>> & { readonly id: string };

export function DataTable({
  label,
  columns,
  rows,
  empty,
}: {
  /** The table's accessible name: the chart it stands in for. */
  readonly label: string;
  readonly columns: readonly Column[];
  readonly rows: readonly Row[];
  /** Said in place of the body when there are no rows. */
  readonly empty: string;
}): ReactNode {
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label={label}>
        <TableHead>
          <TableRow>
            {columns.map((column) => (
              <TableCell
                key={column.key}
                sx={{ textAlign: column.numeric === true ? 'end' : 'start', whiteSpace: 'nowrap' }}
              >
                {column.label}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length}>
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  {empty}
                </Typography>
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                {columns.map((column) => (
                  <TableCell
                    key={column.key}
                    sx={{
                      textAlign: column.numeric === true ? 'end' : 'start',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {column.numeric === true ? (
                      <Typography variant="mono" component="span">
                        {row[column.key]}
                      </Typography>
                    ) : (
                      row[column.key]
                    )}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </Box>
  );
}
