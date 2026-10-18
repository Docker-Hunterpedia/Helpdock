type DateFormat = 'iso' | 'dmy' | 'mdy' | 'epoch-seconds' | 'epoch-milliseconds';
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timezone: string) {
  const cached = zoneFormatters.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const oldest = zoneFormatters.keys().next().value;
  if (zoneFormatters.size >= 100 && oldest !== undefined) zoneFormatters.delete(oldest);
  zoneFormatters.set(timezone, formatter);
  return formatter;
}

function dateParts(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new Error('invalid-date');
  return date.getTime();
}

function zonedInstant(wall: number, timezone: string): number {
  const formatter = zoneFormatter(timezone);
  const localTime = (timestamp: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(timestamp).map((part) => [part.type, part.value]),
    );
    return (
      dateParts(Number(parts.year), Number(parts.month), Number(parts.day)) +
      Number(parts.hour) * 3600000 +
      Number(parts.minute) * 60000 +
      Number(parts.second) * 1000 +
      (((timestamp % 1000) + 1000) % 1000)
    );
  };
  const candidates = new Set<number>();
  for (const shift of [-86400000, 0, 86400000]) {
    const probe = wall + shift;
    const candidate = wall - (localTime(probe) - probe);
    if (localTime(candidate) === wall) candidates.add(candidate);
  }
  if (candidates.size !== 1) throw new Error('ambiguous-date');
  const candidate = candidates.values().next().value;
  if (candidate === undefined) throw new Error('invalid-date');
  return candidate;
}

/** Explicit formats avoid machine-local dates and guessing ambiguous day/month order. */
export function fileDate(value: string, format: DateFormat, timezone: string): string {
  if (format === 'iso') {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))
      throw new Error('invalid-date');
    dateParts(Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10)));
    if (
      Number(value.slice(11, 13)) > 23 ||
      Number(value.slice(14, 16)) > 59 ||
      Number(value.slice(17, 19)) > 59
    )
      throw new Error('invalid-date');
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new Error('invalid-date');
    return new Date(timestamp).toISOString();
  }
  if (format.startsWith('epoch-')) {
    if (!/^-?\d+$/.test(value)) throw new Error('invalid-date');
    const timestamp = Number(value) * (format === 'epoch-seconds' ? 1000 : 1);
    if (!Number.isSafeInteger(timestamp) || !Number.isFinite(new Date(timestamp).getTime()))
      throw new Error('invalid-date');
    return new Date(timestamp).toISOString();
  }
  const match =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(
      value,
    );
  if (!match) throw new Error('invalid-date');
  const month = Number(match[format === 'dmy' ? 2 : 1]);
  const day = Number(match[format === 'dmy' ? 1 : 2]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) throw new Error('invalid-date');
  const milliseconds = Number((match[7] ?? '').padEnd(3, '0'));
  const wall =
    dateParts(Number(match[3]), month, day) +
    hour * 3600000 +
    minute * 60000 +
    second * 1000 +
    milliseconds;
  return new Date(zonedInstant(wall, timezone)).toISOString();
}
