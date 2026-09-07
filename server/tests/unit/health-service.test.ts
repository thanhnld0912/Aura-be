import { describe, expect, it, vi } from 'vitest';
import { HealthService } from '../../src/modules/health/health.service.js';

describe('HealthService', () => {
  it('reports ok when every check passes', async () => {
    const service = new HealthService().register({
      name: 'database',
      critical: true,
      cacheMs: 0,
      run: async () => {},
    });

    const { body, statusCode } = await service.report();
    expect(statusCode).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ database: 'ok' });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 when a critical check fails', async () => {
    const service = new HealthService().register({
      name: 'database',
      critical: true,
      cacheMs: 0,
      run: async () => {
        throw new Error('connection refused');
      },
    });

    const { body, statusCode } = await service.report();
    expect(statusCode).toBe(503);
    expect(body.status).toBe('error');
    expect(body.checks['database']).toBe('error');
  });

  it('reports degraded — not unhealthy — when only a non-critical check fails', async () => {
    // A degraded AI vendor must not restart the container (API_DESIGN.md §3).
    const service = new HealthService()
      .register({ name: 'database', critical: true, cacheMs: 0, run: async () => {} })
      .register({
        name: 'anthropic',
        critical: false,
        cacheMs: 60_000,
        run: async () => {
          throw new Error('502 from upstream');
        },
      });

    const { body, statusCode } = await service.report();
    expect(statusCode).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.checks).toEqual({ database: 'ok', anthropic: 'error' });
  });

  it('caches a check for its window and re-runs it afterwards', async () => {
    let now = 1_000_000;
    const run = vi.fn(async () => {});
    const service = new HealthService(() => now).register({
      name: 'anthropic',
      critical: false,
      cacheMs: 60_000,
      run,
    });

    await service.report();
    now += 59_000;
    await service.report();
    expect(run).toHaveBeenCalledTimes(1);

    now += 2_000;
    await service.report();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('omits checks that no phase has implemented yet', async () => {
    const { body } = await new HealthService()
      .register({ name: 'database', critical: true, cacheMs: 0, run: async () => {} })
      .report();
    expect(Object.keys(body.checks)).toEqual(['database']);
  });
});
