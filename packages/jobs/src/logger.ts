/**
 * The slice of pino this package uses (ARCHITECTURE §14). Taking an interface
 * rather than importing pino keeps the package framework-free and lets a test
 * pass a recorder; the api and the worker pass their real logger.
 */
export interface JobLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** Discards everything. The default, so a caller that has no logger yet still runs. */
export const silentLogger: JobLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
