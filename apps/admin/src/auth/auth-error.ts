export const retryAfterMinutes = (retryAfter: number | undefined): number =>
  Math.max(1, Math.ceil((retryAfter ?? 900) / 60));
