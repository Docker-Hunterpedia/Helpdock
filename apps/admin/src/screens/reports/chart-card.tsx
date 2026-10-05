import { Box, Button, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { Download, Table2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../app/i18n.js';
import { useSemanticTokens } from '../../app/tokens.js';

/**
 * DESIGN §6.3 ChartCard (M8-04): a report's title and what it counts, an
 * optional breakdown control, "Table" that swaps the plot for the same
 * numbers as a table, and "Export CSV". The two buttons name their chart, so
 * a screen reader hears which of eleven "Table" buttons it is on.
 */

export interface LegendEntry {
  readonly label: string;
  readonly colour: string;
  /** Drawn as a dashed line rather than a square: the p90 series. */
  readonly dashed?: boolean;
}

export interface Breakdown<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  onChange(value: T): void;
}

export function ChartCard<T extends string = never>({
  title,
  caption,
  headline,
  legend,
  breakdown,
  chart,
  table,
  onExport,
  exporting = false,
  wide = false,
}: {
  readonly title: string;
  readonly caption: string;
  readonly headline?: { readonly figure: string; readonly sentence: string } | undefined;
  readonly legend?: readonly LegendEntry[] | undefined;
  readonly breakdown?: Breakdown<T> | undefined;
  readonly chart: ReactNode;
  /** The same numbers as a table; absent for a card that has nothing to tabulate. */
  readonly table?: ReactNode;
  /** Absent for a report with no CSV export (the AI cards). */
  readonly onExport?: (() => void) | undefined;
  readonly exporting?: boolean;
  /** Spans both columns of the report grid. */
  readonly wide?: boolean;
}): ReactNode {
  const t = useT();
  const tokens = useSemanticTokens();
  const headingId = useId();
  const [asTable, setAsTable] = useState(false);

  return (
    <Box
      component="section"
      aria-labelledby={headingId}
      sx={{
        gridColumn: wide ? '1 / -1' : 'auto',
        borderRadius: '10px',
        border: `1px solid ${tokens['border.default']}`,
        backgroundColor: tokens['bg.surface'],
        minWidth: 0,
      }}
    >
      <Box
        sx={{
          paddingBlock: 3,
          paddingInline: 4,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 3,
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography id={headingId} variant="h3" component="h2">
            {title}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
            {caption}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          {breakdown === undefined ? null : (
            <ToggleButtonGroup
              size="small"
              exclusive
              value={breakdown.value}
              aria-label={breakdown.label}
              onChange={(_event, value: T | null) => {
                if (value !== null) {
                  breakdown.onChange(value);
                }
              }}
              sx={{ height: 28 }}
            >
              {breakdown.options.map((option) => (
                <ToggleButton key={option.value} value={option.value}>
                  {option.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          )}
          {table === undefined ? null : (
            <Button
              variant="outlined"
              size="small"
              aria-pressed={asTable}
              aria-label={t('reports:card.table', { chart: title })}
              startIcon={<Table2 size={16} aria-hidden="true" />}
              onClick={() => {
                setAsTable((current) => !current);
              }}
            >
              {t('reports:card.tableShort')}
            </Button>
          )}
          {onExport === undefined ? null : (
            <Button
              variant="outlined"
              size="small"
              disabled={exporting}
              aria-label={t('reports:card.export', { chart: title })}
              startIcon={<Download size={16} aria-hidden="true" />}
              onClick={onExport}
            >
              {t('reports:card.exportShort')}
            </Button>
          )}
        </Box>
      </Box>

      <Box sx={{ paddingInline: 4, paddingBlockEnd: 4, display: 'grid', gap: 3, minWidth: 0 }}>
        {headline === undefined ? null : (
          <Box sx={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 2 }}>
            <Typography
              variant="mono"
              component="p"
              sx={{ fontSize: 32, lineHeight: '40px', fontWeight: 500 }}
            >
              <bdi dir="ltr">{headline.figure}</bdi>
            </Typography>
            <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
              {headline.sentence}
            </Typography>
          </Box>
        )}
        {asTable || legend === undefined || legend.length === 0 ? null : (
          <Legend entries={legend} />
        )}
        {asTable && table !== undefined ? table : chart}
      </Box>
    </Box>
  );
}

function Legend({ entries }: { readonly entries: readonly LegendEntry[] }): ReactNode {
  return (
    <Box
      component="ul"
      sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 4 }}
    >
      {entries.map((entry) => (
        <Box
          component="li"
          key={entry.label}
          sx={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 12 }}
        >
          {entry.dashed === true ? (
            <svg width="16" height="12" aria-hidden="true">
              <line
                x1="0"
                y1="6"
                x2="16"
                y2="6"
                stroke={entry.colour}
                strokeWidth="2"
                strokeDasharray="5 3"
              />
            </svg>
          ) : (
            <Box
              component="span"
              aria-hidden="true"
              sx={{ width: 12, height: 12, backgroundColor: entry.colour, flexShrink: 0 }}
            />
          )}
          {entry.label}
        </Box>
      ))}
    </Box>
  );
}
