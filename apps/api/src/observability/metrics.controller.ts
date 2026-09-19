import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import { Registry } from 'prom-client';
import { Public } from '../auth/route-declaration.js';
import { MetricsGuard } from './metrics.guard.js';
import type { Metrics } from './metrics.js';
import { METRICS } from './tokens.js';

/**
 * `/metrics` in the Prometheus text format (ARCHITECTURE §14).
 *
 * `@Public()` is about sessions: a scraper has none. {@link MetricsGuard} is
 * what actually decides, and it runs after the global guards because Nest
 * executes global, then controller, then route guards.
 *
 * There is no `@ZodSerializerDto` here because the body is not JSON. It is
 * produced by `prom-client` from the registry, so nothing this app writes can
 * leak into it that is not a metric that was deliberately registered.
 */
@Controller()
@UseGuards(MetricsGuard)
export class MetricsController {
  readonly #metrics: Metrics;

  constructor(@Inject(METRICS) metrics: Metrics) {
    this.#metrics = metrics;
  }

  @Get('metrics')
  @Public()
  @Header('Content-Type', Registry.PROMETHEUS_CONTENT_TYPE)
  @Header('Cache-Control', 'no-store')
  async scrape(): Promise<string> {
    return this.#metrics.registry.metrics();
  }
}
