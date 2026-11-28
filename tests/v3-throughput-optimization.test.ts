import { describe, expect, it } from 'vitest';
import { HostRateLimiter } from '../src/core/rate-limiter.js';
import { SOURCE_CONCURRENCY_LIMITS } from '../src/core/concurrency.js';
import { SourcePerformanceTracker } from '../src/lite/source-performance.js';

describe('V3 throughput optimization guarantees', () => {
  it('acquires available HostRateLimiter tokens without artificial per-page delay and ramps AIMD +1.0 per 8 successes', async () => {
    const limiter = new HostRateLimiter(5.0);
    limiter.setHostRate('cdn.example.test', 8.0, 16, 24.0);

    const t0 = performance.now();
    for (let i = 0; i < 8; i++) {
      await limiter.acquire('cdn.example.test');
      limiter.recordSuccess('cdn.example.test');
    }
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(60);
    expect(limiter.getHostRate('cdn.example.test')).toBe(9.0);
  });

  it('prevents false SLOW demotion on fast-completing chapters and warm-starts manhastro as NORMAL', () => {
    const tracker = new SourcePerformanceTracker();
    expect(tracker.getTier('manhastro')).toBe('NORMAL');

    for (let i = 0; i < 15; i++) {
      tracker.recordPageDownload('nexus-like', i === 0 ? 18_000 : 1_800, 400_000);
    }
    tracker.recordChapterOutcome('nexus-like', { succeeded: true, durationMs: 40_000, pageCount: 25 });
    expect(tracker.getTier('nexus-like')).not.toBe('SLOW');
  });

  it('configures CloudFront/Madara throughput caps for brscans and hanamiheaven', () => {
    expect(SOURCE_CONCURRENCY_LIMITS.brscans).toEqual({
      maxChapters: 6,
      fairMaxChapters: 5,
      maxPagesPerChapter: 10,
    });
    expect(SOURCE_CONCURRENCY_LIMITS.hanamiheaven).toEqual({
      maxChapters: 4,
      fairMaxChapters: 3,
      maxPagesPerChapter: 6,
    });
  });
});
