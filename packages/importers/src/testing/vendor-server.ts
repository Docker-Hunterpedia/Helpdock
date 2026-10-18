import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { VendorRequestGates } from './request-gate.js';

export type VendorAnswer = {
  status: number;
  json?: unknown;
  bytes?: Buffer;
  headers?: Record<string, string>;
};
export type VendorCall = {
  method: string;
  path: string;
  query: Record<string, string>;
  authenticated: boolean;
};
export type VendorFailure = VendorAnswer & { path: string };

/** Test-only read server: unexpected source mutations are visible as failed requests. */
export class VendorServer {
  readonly calls: VendorCall[] = [];
  private readonly failures: VendorFailure[] = [];
  private readonly server: Server;
  private readonly gates = new VendorRequestGates();

  constructor(
    private readonly route: (url: URL, authorization: string | undefined) => VendorAnswer,
  ) {
    this.server = createServer((request, response) => {
      void this.respond(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
  }

  get root(): string {
    const address = this.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Vendor stand-in is not listening');
    return `http://127.0.0.1:${(address as AddressInfo).port}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.gates.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  failNext(failure: VendorFailure): void {
    this.failures.push(failure);
  }

  holdNextRequest(path: string) {
    return this.gates.hold(path);
  }

  private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.root);
    this.calls.push({
      method: request.method ?? '',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authenticated: Boolean(request.headers.authorization),
    });
    await this.gates.wait(url.pathname);
    const failedIndex = this.failures.findIndex((failure) => failure.path === url.pathname);
    const failure = failedIndex < 0 ? undefined : this.failures.splice(failedIndex, 1)[0];
    const answer =
      request.method !== 'GET'
        ? { status: 405, json: { error: 'Read-only migration stand-in' } }
        : (failure ?? this.route(url, request.headers.authorization));
    response.writeHead(answer.status, {
      'content-type': answer.bytes ? 'application/octet-stream' : 'application/json',
      connection: 'close',
      ...answer.headers,
    });
    response.end(answer.bytes ?? JSON.stringify(answer.json ?? {}));
  }
}
