import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { recordResponse, responseOf, routeLabel, UNMATCHED_ROUTE } from './http-metrics.js';
import { createMetrics } from './metrics.js';

const asRequest = (routeUrl: string | undefined, method = 'GET'): FastifyRequest =>
  ({ method, routeOptions: { url: routeUrl } }) as unknown as FastifyRequest;

const asReply = (statusCode: number, elapsedTime = 12): FastifyReply =>
  ({ statusCode, elapsedTime }) as unknown as FastifyReply;

describe('routeLabel', () => {
  it('is the route template, so one route is one series whatever the ids in it', () => {
    expect(routeLabel('/api/brands/:brandId')).toBe('/api/brands/:brandId');
  });

  it('collapses everything unmatched into one label', () => {
    expect(routeLabel(undefined)).toBe(UNMATCHED_ROUTE);
    expect(routeLabel('')).toBe(UNMATCHED_ROUTE);
  });
});

describe('responseOf', () => {
  it('reads the template Fastify matched and never the url that was asked for', () => {
    const request = asRequest('/api/brands/:brandId');
    // What the client actually sent; it must not appear anywhere in the label.
    Object.assign(request, { url: '/api/brands/0192c3f0-1a2b-7c3d-8e4f-000000000001?q=lina' });

    expect(responseOf(request, asReply(200))).toEqual({
      route: '/api/brands/:brandId',
      method: 'GET',
      status: 200,
      durationMs: 12,
    });
  });
});

describe('recordResponse', () => {
  it('counts the response and observes its duration in seconds', async () => {
    const metrics = createMetrics();

    recordResponse(metrics, {
      route: '/api/brands/:brandId',
      method: 'GET',
      status: 200,
      durationMs: 250,
    });

    const scrape = await metrics.registry.metrics();
    expect(scrape).toContain(
      'http_requests_total{route="/api/brands/:brandId",method="GET",status="200"} 1',
    );
    expect(scrape).toContain(
      'http_request_duration_seconds_sum{route="/api/brands/:brandId",method="GET",status="200"} 0.25',
    );
  });

  it('separates statuses, so a 5xx rate is a rate and not a share of one number', async () => {
    const metrics = createMetrics();
    const base = { route: '/ready', method: 'GET', durationMs: 5 };

    recordResponse(metrics, { ...base, status: 200 });
    recordResponse(metrics, { ...base, status: 200 });
    recordResponse(metrics, { ...base, status: 503 });

    const scrape = await metrics.registry.metrics();
    expect(scrape).toContain('http_requests_total{route="/ready",method="GET",status="200"} 2');
    expect(scrape).toContain('http_requests_total{route="/ready",method="GET",status="503"} 1');
  });
});
