import { API_VERSION } from '../../lib/version.js';
import type { CheckStatus, HealthResponse } from './health.schema.js';

/**
 * Health checks are a registry rather than a fixed list, because the dependencies
 * arrive in phases: `database` now, `storage`/`anthropic`/`gemini` when Phase 4
 * introduces clients that can actually be probed. Reporting `"ok"` for a provider
 * nothing has contacted would be a fabricated result, so an unimplemented check is
 * simply absent from `checks`.
 *
 * Only a *critical* check can fail the endpoint. A degraded AI vendor must not mark
 * the API unhealthy and trigger a platform restart loop (API_DESIGN.md §3), so
 * provider checks are cached and advisory.
 */
export interface HealthCheck {
  readonly name: string;
  /** A failing critical check returns 503. */
  readonly critical: boolean;
  /** Result reuse window. 0 = always run. Provider checks use 60_000. */
  readonly cacheMs: number;
  run(): Promise<void>;
}

interface CachedResult {
  status: CheckStatus;
  at: number;
}

export class HealthService {
  private readonly checks: HealthCheck[] = [];
  private readonly cache = new Map<string, CachedResult>();

  constructor(private readonly now: () => number = Date.now) {}

  register(check: HealthCheck): this {
    this.checks.push(check);
    return this;
  }

  private async runCheck(check: HealthCheck): Promise<CheckStatus> {
    const cached = this.cache.get(check.name);
    if (cached && check.cacheMs > 0 && this.now() - cached.at < check.cacheMs) {
      return cached.status;
    }

    let status: CheckStatus;
    try {
      await check.run();
      status = 'ok';
    } catch {
      status = 'error';
    }

    this.cache.set(check.name, { status, at: this.now() });
    return status;
  }

  async report(): Promise<{ body: HealthResponse; statusCode: 200 | 503 }> {
    const results = await Promise.all(
      this.checks.map(async (check) => ({
        check,
        status: await this.runCheck(check),
      })),
    );

    const checks: Record<string, CheckStatus> = {};
    for (const { check, status } of results) checks[check.name] = status;

    const criticalFailed = results.some((r) => r.check.critical && r.status === 'error');
    const anyFailed = results.some((r) => r.status === 'error');

    const status: HealthResponse['status'] = criticalFailed
      ? 'error'
      : anyFailed
        ? 'degraded'
        : 'ok';

    return {
      body: {
        status,
        version: API_VERSION,
        uptime: Math.floor(process.uptime()),
        checks,
      },
      statusCode: criticalFailed ? 503 : 200,
    };
  }
}
