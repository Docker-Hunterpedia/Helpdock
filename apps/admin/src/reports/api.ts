import {
  type ReportExport,
  type ReportQuery,
  type ReportSummary,
  reportSummarySchema,
} from '@helpdock/schemas';
import { HttpTransport } from '../auth/http-transport.js';

/**
 * Everything `Admin/Reports` reads (M8-04): the summary the cards draw, and
 * one report's rows as CSV for "Export CSV". There is no fixture adapter: the
 * unit tests pass their own object and the browser tests answer the two
 * routes with Playwright, as the System page's do.
 */
export interface ReportsApi {
  summary(brandId: string, query: ReportQuery): Promise<ReportSummary>;
  exportCsv(brandId: string, report: ReportExport, query: ReportQuery): Promise<Blob>;
}

/** The query string both routes take, with only the filters that are set. */
export const reportSearch = (query: ReportQuery): string => {
  const params = new URLSearchParams({ from: query.from, to: query.to });
  if (query.departmentId !== undefined) {
    params.set('departmentId', query.departmentId);
  }
  if (query.channel !== undefined) {
    params.set('channel', query.channel);
  }

  return params.toString();
};

/**
 * The real service, on the app's shared {@link HttpTransport} so the access
 * token and its refresh are the ones every other screen uses.
 */
export class HttpReportsApi implements ReportsApi {
  readonly #transport: HttpTransport;

  constructor(transport: HttpTransport = new HttpTransport()) {
    this.#transport = transport;
  }

  async summary(brandId: string, query: ReportQuery): Promise<ReportSummary> {
    return reportSummarySchema.parse(
      await this.#transport.request('GET', `${this.#reports(brandId)}?${reportSearch(query)}`),
    );
  }

  async exportCsv(brandId: string, report: ReportExport, query: ReportQuery): Promise<Blob> {
    return this.#transport.requestBlob(
      `${this.#reports(brandId)}/exports/${report}?${reportSearch(query)}`,
    );
  }

  #reports(brandId: string): string {
    return `/brands/${encodeURIComponent(brandId)}/reports`;
  }
}
