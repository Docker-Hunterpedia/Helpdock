import { tokens as designTokens } from '@helpdock/ui';
import { Box, Tooltip, Typography } from '@mui/material';
import { type ReactNode, useState } from 'react';
import { useSemanticTokens } from '../../app/tokens.js';
import { HOURS, heatmapThresholds, stepOf, WEEKDAYS } from './heatmap-scale.js';

/**
 * The plots of `Admin/Reports` as plain SVG (no charting dependency is in the
 * ARCHITECTURE §1 stack). Each follows DESIGN §9 and the ChartCard entry of
 * §6.3: one `svg` with `role="img"` and its figures in the label, square bars,
 * 2 px lines, an end marker with a direct label, grid lines on
 * `border.default`, axis text at 12 in `text.secondary`, and a Tooltip that
 * names the series. The plots stay left to right in Arabic too: time and
 * numerals run left to right in both (DESIGN §7), and the card around them
 * mirrors.
 */

const PALETTE = designTokens.palette;

/** The n-th hue of DESIGN §9's categorical order. */
const categorical = (index: number): string =>
  PALETTE.chart.categorical[index] ?? PALETTE.teal.teal500;
/** The first two series: teal500 and info. */
export const SERIES_PRIMARY = categorical(0);
export const SERIES_SECONDARY = categorical(1);
/** The Heatmap's six steps, teal100 to teal500 and teal700. */
const SEQUENTIAL = [
  PALETTE.teal.teal100,
  PALETTE.teal.teal200,
  PALETTE.teal.teal300,
  PALETTE.teal.teal400,
  PALETTE.teal.teal500,
  PALETTE.teal.teal700,
] as const;

const WIDTH = 720;
const HEIGHT = 200;
const AXIS_START = 36;
const AXIS_BOTTOM = 24;
const TOP = 8;
const END = 72;
const GRID_LINES = 4;
const BAR_GAP = 2;
const X_LABELS = 6;

/** A round ceiling for the y axis: 1, 2 or 5 times a power of ten. */
export const niceMax = (max: number): number => {
  if (max <= 0) {
    return GRID_LINES;
  }
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 5, 10].find((candidate) => candidate * magnitude >= max) ?? 10;

  return step * magnitude;
};

/** About {@link X_LABELS} evenly spaced indexes, always including the last. */
const labelIndexes = (count: number): Set<number> => {
  const every = Math.max(1, Math.ceil(count / X_LABELS));
  const indexes = new Set<number>();
  for (let index = 0; index < count; index += every) {
    indexes.add(index);
  }
  indexes.add(count - 1);
  return indexes;
};

interface Axes {
  readonly max: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly yOf: (value: number) => number;
}

const axesFor = (maxValue: number): Axes => {
  const max = niceMax(maxValue);
  const plotHeight = HEIGHT - TOP - AXIS_BOTTOM;

  return {
    max,
    plotWidth: WIDTH - AXIS_START - END,
    plotHeight,
    yOf: (value) => TOP + plotHeight - (value / max) * plotHeight,
  };
};

function Grid({ axes }: { readonly axes: Axes }): ReactNode {
  const semantic = useSemanticTokens();

  return (
    <g>
      {Array.from({ length: GRID_LINES + 1 }, (_unused, index) => {
        const value = (axes.max / GRID_LINES) * index;
        const y = axes.yOf(value);
        return (
          <g key={value}>
            <line
              x1={AXIS_START}
              x2={AXIS_START + axes.plotWidth}
              y1={y}
              y2={y}
              stroke={semantic['border.default']}
              strokeWidth={1}
            />
            <text
              x={AXIS_START - 6}
              y={y + 4}
              textAnchor="end"
              fontSize={12}
              fill={semantic['text.secondary']}
            >
              {value}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** Day labels under the plot, one every few columns. */
function DayAxis({
  labels,
  xOf,
}: {
  readonly labels: readonly string[];
  readonly xOf: (index: number) => number;
}): ReactNode {
  const semantic = useSemanticTokens();
  const shown = labelIndexes(labels.length);

  return (
    <g>
      {labels.map((label, index) =>
        shown.has(index) ? (
          <text
            key={label}
            x={xOf(index)}
            y={HEIGHT - 6}
            textAnchor="middle"
            fontSize={12}
            fill={semantic['text.secondary']}
          >
            {label}
          </text>
        ) : null,
      )}
    </g>
  );
}

const svgStyle = {
  width: '100%',
  height: 'auto',
  display: 'block',
  overflow: 'visible',
  direction: 'ltr',
} as const;

/**
 * One series of columns, a day each (Ticket volume). The api gives created
 * tickets per day, not per channel per day, so the breakdown the artboard
 * stacks is drawn beside the plot as share rows instead.
 */
export function ColumnChart({
  label,
  dayLabels,
  values,
  tooltipOf,
}: {
  readonly label: string;
  /** One axis label per column. */
  readonly dayLabels: readonly string[];
  readonly values: readonly number[];
  /** The hover Tooltip's text for one column, naming the series. */
  readonly tooltipOf: (index: number) => string;
}): ReactNode {
  const semantic = useSemanticTokens();
  const [hovered, setHovered] = useState<number | null>(null);
  const axes = axesFor(Math.max(0, ...values));
  const slot = axes.plotWidth / Math.max(1, values.length);
  const xOf = (index: number): number => AXIS_START + slot * index + slot / 2;

  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={svgStyle}>
      {hovered === null ? null : (
        <rect
          x={AXIS_START + slot * hovered}
          y={TOP}
          width={slot}
          height={axes.plotHeight}
          fill={semantic['bg.muted']}
        />
      )}
      <Grid axes={axes} />
      {values.map((value, index) => {
        const y = axes.yOf(value);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: one column per day of a fixed range.
          <g key={index}>
            <rect
              x={AXIS_START + slot * index + BAR_GAP / 2}
              y={y}
              width={Math.max(1, slot - BAR_GAP)}
              height={TOP + axes.plotHeight - y}
              fill={SERIES_PRIMARY}
            />
            <Tooltip
              title={tooltipOf(index)}
              placement="top"
              disableInteractive
              describeChild
              onOpen={() => {
                setHovered(index);
              }}
              onClose={() => {
                setHovered(null);
              }}
            >
              <rect
                x={AXIS_START + slot * index}
                y={TOP}
                width={slot}
                height={axes.plotHeight}
                fill="transparent"
              />
            </Tooltip>
          </g>
        );
      })}
      <DayAxis labels={dayLabels} xOf={xOf} />
    </svg>
  );
}

/**
 * One line over the days (Backlog trend), with an 8 px end marker ringed in
 * `bg.surface` and its value labelled at the end, as §9 asks.
 */
export function LineChart({
  label,
  dayLabels,
  values,
  endLabel,
  tooltipOf,
}: {
  readonly label: string;
  readonly dayLabels: readonly string[];
  readonly values: readonly number[];
  /** The direct label at the line's end ("142 open"). */
  readonly endLabel: string;
  readonly tooltipOf: (index: number) => string;
}): ReactNode {
  const semantic = useSemanticTokens();
  const [hovered, setHovered] = useState<number | null>(null);
  const axes = axesFor(Math.max(0, ...values));
  const step = values.length > 1 ? axes.plotWidth / (values.length - 1) : 0;
  const xOf = (index: number): number => AXIS_START + step * index;
  const points = values.map((value, index) => `${xOf(index)},${axes.yOf(value)}`).join(' ');
  const last = values.length - 1;
  const lastValue = values[last] ?? 0;
  const hitWidth = Math.max(step, 4);

  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} style={svgStyle}>
      {hovered === null ? null : (
        <rect
          x={xOf(hovered) - hitWidth / 2}
          y={TOP}
          width={hitWidth}
          height={axes.plotHeight}
          fill={semantic['bg.muted']}
        />
      )}
      <Grid axes={axes} />
      {values.length === 0 ? null : (
        <>
          <polyline points={points} fill="none" stroke={SERIES_PRIMARY} strokeWidth={2} />
          <circle
            cx={xOf(last)}
            cy={axes.yOf(lastValue)}
            r={4}
            fill={SERIES_PRIMARY}
            stroke={semantic['bg.surface']}
            strokeWidth={2}
          />
          <text
            x={xOf(last) + 8}
            y={axes.yOf(lastValue) + 4}
            fontSize={12}
            fill={semantic['text.primary']}
          >
            {endLabel}
          </text>
        </>
      )}
      {values.map((_value, index) => (
        <Tooltip
          // biome-ignore lint/suspicious/noArrayIndexKey: one point per day of a fixed range.
          key={index}
          title={tooltipOf(index)}
          placement="top"
          disableInteractive
          describeChild
          onOpen={() => {
            setHovered(index);
          }}
          onClose={() => {
            setHovered(null);
          }}
        >
          <rect
            x={xOf(index) - hitWidth / 2}
            y={TOP}
            width={hitWidth}
            height={axes.plotHeight}
            fill="transparent"
          />
        </Tooltip>
      ))}
      <DayAxis labels={dayLabels} xOf={xOf} />
    </svg>
  );
}

export interface ShareRow {
  readonly key: string;
  readonly label: string;
  /** 0 to 1, the bar's length. */
  readonly share: number;
  /** The figure at the end, in mono ("86.2 %"). */
  readonly value: string;
  /** What it is out of, in `text.secondary` ("of 94"). */
  readonly of?: string;
  /** A status hue when the bar *is* that status (§9); the first categorical hue otherwise. */
  readonly colour?: string;
}

/**
 * DESIGN §6.3's share-of-whole rows: a 72 px label, a 12 px bar and a 96 px
 * value, the group one image whose label carries every figure.
 */
export function ShareRows({
  label,
  rows,
}: {
  readonly label: string;
  readonly rows: readonly ShareRow[];
}): ReactNode {
  const semantic = useSemanticTokens();

  return (
    <Box role="img" aria-label={label} sx={{ display: 'grid', gap: 2 }}>
      {rows.map((row) => (
        <Box
          key={row.key}
          aria-hidden="true"
          sx={{
            display: 'grid',
            gridTemplateColumns: '72px minmax(0, 1fr) minmax(96px, auto)',
            alignItems: 'center',
            gap: 3,
          }}
        >
          <Typography sx={{ fontSize: 13 }} noWrap>
            {row.label}
          </Typography>
          <Box sx={{ height: 12, backgroundColor: semantic['bg.muted'] }}>
            <Box
              sx={{
                height: '100%',
                width: `${Math.min(100, Math.max(0, row.share * 100))}%`,
                backgroundColor: row.colour ?? SERIES_PRIMARY,
              }}
            />
          </Box>
          <Typography variant="mono" component="span" sx={{ fontSize: 12, textAlign: 'end' }}>
            <bdi dir="ltr">{row.value}</bdi>
            {row.of === undefined ? null : (
              <Typography
                component="span"
                variant="mono"
                sx={{ fontSize: 12, color: 'text.secondary' }}
              >
                {` ${row.of}`}
              </Typography>
            )}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

const CELL_WIDTH = 38;
const CELL_HEIGHT = 22;
const CELL_GAP = 2;
const DAY_LABEL_WIDTH = 40;
const HOUR_LABEL_HEIGHT = 18;
const HOUR_LABEL_EVERY = 3;

/**
 * DESIGN §6.3 Heatmap: weekdays by hours in brand time, each cell one of six
 * sequential steps with the thresholds in a legend above it.
 */
export function Heatmap({
  label,
  grid,
  dayNames,
  legendLabel,
  tooltipOf,
}: {
  readonly label: string;
  /** Seven rows of 24 counts, Monday first. */
  readonly grid: readonly (readonly number[])[];
  readonly dayNames: readonly string[];
  readonly legendLabel: string;
  readonly tooltipOf: (weekdayIndex: number, hour: number, count: number) => string;
}): ReactNode {
  const semantic = useSemanticTokens();
  const thresholds = heatmapThresholds(Math.max(0, ...grid.flat()));
  const width = DAY_LABEL_WIDTH + HOURS.length * (CELL_WIDTH + CELL_GAP);
  const height = WEEKDAYS.length * (CELL_HEIGHT + CELL_GAP) + HOUR_LABEL_HEIGHT;

  return (
    <Box sx={{ display: 'grid', gap: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 400 }}>
          {legendLabel}
        </Typography>
        <Box
          component="ul"
          sx={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', gap: 1 }}
        >
          {thresholds.map((bound, index) => (
            <Box component="li" key={bound} sx={{ display: 'grid', justifyItems: 'center' }}>
              <Box
                component="span"
                aria-hidden="true"
                sx={{
                  width: 32,
                  height: 12,
                  backgroundColor: SEQUENTIAL[index] ?? PALETTE.teal.teal500,
                }}
              />
              <Typography variant="mono" component="span" sx={{ fontSize: 12 }}>
                {`${bound}+`}
              </Typography>
            </Box>
          ))}
        </Box>
      </Box>
      <Box sx={{ overflowX: 'auto' }}>
        <svg
          role="img"
          aria-label={label}
          viewBox={`0 0 ${width} ${height}`}
          style={{ ...svgStyle, minWidth: 560 }}
        >
          {grid.map((row, dayIndex) => {
            const y = dayIndex * (CELL_HEIGHT + CELL_GAP);
            return (
              <g key={dayNames[dayIndex]}>
                <text x={0} y={y + CELL_HEIGHT - 6} fontSize={12} fill={semantic['text.secondary']}>
                  {dayNames[dayIndex]}
                </text>
                {row.map((count, hour) => (
                  <Tooltip
                    // biome-ignore lint/suspicious/noArrayIndexKey: the hour of the day is the cell.
                    key={hour}
                    title={tooltipOf(dayIndex, hour, count)}
                    placement="top"
                    disableInteractive
                    describeChild
                  >
                    <rect
                      x={DAY_LABEL_WIDTH + hour * (CELL_WIDTH + CELL_GAP)}
                      y={y}
                      width={CELL_WIDTH}
                      height={CELL_HEIGHT}
                      fill={SEQUENTIAL[stepOf(count, thresholds)] ?? PALETTE.teal.teal500}
                    />
                  </Tooltip>
                ))}
              </g>
            );
          })}
          <g>
            {HOURS.filter((hour) => hour % HOUR_LABEL_EVERY === 0).map((hour) => (
              <text
                key={hour}
                x={DAY_LABEL_WIDTH + hour * (CELL_WIDTH + CELL_GAP)}
                y={height - 4}
                fontSize={12}
                fill={semantic['text.secondary']}
              >
                {`${String(hour).padStart(2, '0')}:00`}
              </text>
            ))}
          </g>
        </svg>
      </Box>
    </Box>
  );
}
