import { describe, expect, it } from 'vitest';
import { ExistingWorksReconciler } from '../src/core/reconciliation.js';
import { resolvePemInput } from '../src/db/yugabyte-direct.js';
import { getConfig } from '../src/config.js';

describe('V3 PG 18 Compatibility & mTLS Pool Support', () => {
  it('detects absence of yb_servers_metrics on PG 18 and falls back cleanly without error', async () => {
    const queriesExecuted: string[] = [];
    const fakeSupabase = {
      client: {
        async query(sql: string) {
          queriesExecuted.push(sql);
          if (sql.includes("to_regclass('pg_catalog.yb_servers_metrics')")) {
            return { rows: [{ has_yb: false }] };
          }
          return { rows: [{ metrics: null, active_conns: 3 }] };
        },
      },
    } as any;

    const service = new ExistingWorksReconciler(fakeSupabase, {} as any, {} as any);
    const first = await service.getSystemLoad();
    const second = await service.getSystemLoad();

    expect(first).toEqual({ cpuPercent: 0, activeConns: 3 });
    expect(second).toEqual({ cpuPercent: 0, activeConns: 3 });
    // Probe ran only once (memoized)
    expect(queriesExecuted.filter((q) => q.includes('to_regclass')).length).toBe(1);
    expect(queriesExecuted.some((q) => q.includes('FROM yb_servers_metrics'))).toBe(false);
  });

  it('uses yb_servers_metrics when available on YugabyteDB', async () => {
    const fakeSupabase = {
      client: {
        async query(sql: string) {
          if (sql.includes("to_regclass('pg_catalog.yb_servers_metrics')")) {
            return { rows: [{ has_yb: true }] };
          }
          return { rows: [{ metrics: { cpu_usage_user: '0.25', cpu_usage_system: '0.10' }, active_conns: 2 }] };
        },
      },
    } as any;

    const service = new ExistingWorksReconciler(fakeSupabase, {} as any, {} as any);
    const load = await service.getSystemLoad();
    expect(load.cpuPercent).toBeCloseTo(35, 1);
    expect(load.activeConns).toBe(2);
  });

  it('resolves PEM inputs from inline newlines and base64 cleanly', () => {
    const inline = '-----BEGIN CERTIFICATE-----\\nABC123\\n-----END CERTIFICATE-----';
    expect(resolvePemInput(inline)).toContain('-----BEGIN CERTIFICATE-----\nABC123\n-----END CERTIFICATE-----');

    const rawPem = '-----BEGIN PRIVATE KEY-----\nXYZ\n-----END PRIVATE KEY-----\n';
    const b64 = Buffer.from(rawPem, 'utf8').toString('base64');
    expect(resolvePemInput(b64)).toBe(rawPem);

    expect(resolvePemInput(undefined)).toBeUndefined();
  });

  it('exposes V3 safe Discloud defaults (DIRECT_DB_POOL_MAX=4, WEBP_MAX_CONCURRENT=3, DB_MTLS_SERVERNAME)', () => {
    const prev = process.env.YUGABYTE_PASSWORD;
    if (!prev) process.env.YUGABYTE_PASSWORD = 'test-placeholder';
    try {
      const cfg = getConfig();
      expect(cfg.DIRECT_DB_POOL_MAX).toBe(4);
      expect(cfg.WEBP_MAX_CONCURRENT).toBe(3);
      expect(cfg.DB_MTLS_SERVERNAME).toBe('pg-importer.nox.internal');
    } finally {
      if (prev === undefined) delete process.env.YUGABYTE_PASSWORD;
    }
  });
});
