/**
 * A stand-in for an HTTP API, as the `fetch` the connectors take: routes are
 * `METHOD /path` (query ignored) to a JSON body, a status and body, or a
 * function of the request. Every request is recorded. Exported through
 * `testing.ts` so the api's suites can fake Notion and Drive too.
 */

export interface FakeRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type FakeAnswer =
  | { readonly status: number; readonly json?: unknown; readonly text?: string }
  | ((request: FakeRequest) => {
      readonly status: number;
      readonly json?: unknown;
      readonly text?: string;
    });

export interface FakeService {
  readonly fetch: typeof fetch;
  readonly requests: readonly FakeRequest[];
}

const headersOf = (init: RequestInit | undefined): Record<string, string> => {
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, name) => {
    headers[name] = value;
  });
  return headers;
};

const bodyOf = (body: RequestInit['body']): string => {
  if (body === undefined || body === null) {
    return '';
  }
  return typeof body === 'string' ? body : String(body);
};

export const fakeService = (routes: Readonly<Record<string, FakeAnswer>>): FakeService => {
  const requests: FakeRequest[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const request: FakeRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      headers: headersOf(init),
      body: bodyOf(init?.body),
    };
    requests.push(request);
    const route = routes[`${request.method} ${url.pathname}`];
    const answer =
      route === undefined
        ? { status: 404, json: { object: 'error', code: 'object_not_found', message: 'not found' } }
        : typeof route === 'function'
          ? route(request)
          : route;
    const text = answer.text ?? JSON.stringify(answer.json ?? {});
    return Promise.resolve(
      new Response(text, {
        status: answer.status,
        headers: { 'content-type': answer.text === undefined ? 'application/json' : 'text/plain' },
      }),
    );
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
};
