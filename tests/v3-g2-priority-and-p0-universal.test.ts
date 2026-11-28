import { describe, expect, it } from 'vitest';
import { LITE_PRIORITIES, LITE_PRIORITY_RANK } from '../src/lite/types.js';
import { ALIAS_ONLY_SOURCE_IDS } from '../src/alias-sources/types.js';
import {
  InMemoryP0UniversalCheckpointStore,
  P0UniversalScanner,
  type CanonicalP0Work,
  type P0SourceCatalogFetchResult,
  type P0SourceDescriptor,
} from '../src/lite/p0-universal-scanner.js';
import { P0CycleCoordinator, SourceCatalogMatcher } from '../src/lite/p0-cycle-coordinator.js';

function make43MainSources(overrides: Partial<Record<string, P0SourceDescriptor['status']>> = {}): P0SourceDescriptor[] {
  return Array.from({ length: 43 }, (_, idx) => {
    const id = `main-src-${String(idx + 1).padStart(2, '0')}`;
    return {
      id,
      status: overrides[id] ?? 'HEALTHY',
      hasFullCatalogSupport: true,
    };
  });
}

function makeWorks(count: number): CanonicalP0Work[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: `work-${idx}`,
    title: `Crônica do Reino ${idx}`,
    slug: `cronica-do-reino-${idx}`,
    aliases: [`Kingdom Chronicle ${idx}`],
    popularScore: idx < 20 ? 1000 - idx : 1,
    knownLatestOrderBySource: {
      'main-src-01': 'n|000000000010.0000',
      'main-src-43': 'n|000000000010.0000',
    },
  }));
}

describe('Gate G2 — Priority P0 > STAFF > P1 > P2 & P0 Universal 43 x N Coverage', () => {
  it('enforces P0 (0) > STAFF (1) > P1 (2) > P2 (3) and dynamic P0 coordinator defaults', () => {
    expect(LITE_PRIORITIES).toEqual(['P0', 'STAFF', 'P1', 'P2']);
    expect(LITE_PRIORITY_RANK).toEqual({ P0: 0, STAFF: 1, P1: 2, P2: 3 });

    const works = [{ id: 'w1', title: 'Alpha', slug: 'alpha', aliases: [] }];
    const coordinator = new P0CycleCoordinator({ matcher: new SourceCatalogMatcher(works) });
    expect((coordinator as any).eligibleWorkCount).toBe(1);
    expect((coordinator as any).negativeCacheTtlMs).toBe(0);
  });

  it('rejects any ALIAS_ONLY source from entering P0 universal scanner', () => {
    const works = makeWorks(5);
    for (const forbidden of ALIAS_ONLY_SOURCE_IDS) {
      expect(() => new P0UniversalScanner(works, [{ id: forbidden, status: 'HEALTHY' }])).toThrow(
        'FORBIDDEN_ALIAS_SOURCE_IN_P0',
      );
    }
  });

  it('evaluates 10,000 x 43 = 430,000 pairs and 23,000 x 43 = 989,000 pairs with an independent oracle & < 2 MiB matrix', async () => {
    const sources = make43MainSources({ 'main-src-42': 'BLOCKED' });

    for (const n of [10_000, 23_000]) {
      const works = makeWorks(n);
      const scanner = new P0UniversalScanner(works, sources, { pauseWindowMs: 0 });
      const report = await scanner.runCycle({
        async fetchSourceCatalog(source): Promise<P0SourceCatalogFetchResult> {
          if (source.id === 'main-src-41') {
            return { sourceId: source.id, outcome: 'RATE_LIMITED', items: [], httpCallsUsed: 1 };
          }
          if (source.id === 'main-src-43') {
            // Partial catalog must NOT fabricate NOT_FOUND_ON_SOURCE for unmatched works
            return {
              sourceId: source.id,
              outcome: 'OK_PARTIAL',
              items: [
                { sourceWorkId: 'ext-0', title: works[0].title, latestChapter: 'n|000000000010.0000', chapterCount: 10 },
              ],
              httpCallsUsed: 1,
            };
          }
          // Complete catalog resolving works 0..9 in batch using Portuguese + English aliases
          return {
            sourceId: source.id,
            outcome: 'OK_COMPLETE',
            items: works.slice(0, 10).map((w, i) => ({
              sourceWorkId: `${source.id}:${w.id}`,
              title: i % 2 === 0 ? w.title : w.aliases![0],
              slug: w.slug,
              latestChapter:
                i === 0 && source.id === 'main-src-01' ? 'n|000000000011.0000' : 'n|000000000010.0000',
              chapterCount: 10,
            })),
            httpCallsUsed: 1,
          };
        },
      });

      // Exact oracle assertions
      expect(report.totalLogicalPairs).toBe(n * 43);
      expect(report.evaluatedPairs).toBe(n * 43);
      expect(report.matrix.data.byteLength).toBe(n * 43);
      // 41 healthy/rate-limited HTTP requests (not 43 * N!)
      expect(report.httpCallsUsed).toBeLessThanOrEqual(43);

      // Verify specific oracle verdicts
      expect(report.matrix.getStatus('work-0', 'main-src-01')).toBe('NEW_CHAPTER_FOUND');
      expect(report.matrix.getStatus('work-1', 'main-src-01')).toBe('UP_TO_DATE');
      expect(report.matrix.getStatus('work-10', 'main-src-01')).toBe('NOT_FOUND_ON_SOURCE');
      expect(report.matrix.getStatus('work-0', 'main-src-42')).toBe('SKIPPED_BLOCKED_SOURCE');
      expect(report.matrix.getStatus('work-500', 'main-src-41')).toBe('RATE_LIMITED');
      // Partial catalog verified work-0 cleanly but marked unchecked tail honestly as TRANSIENT_ERROR (never false NOT_FOUND)
      expect(report.matrix.getStatus('work-0', 'main-src-43')).toBe('UP_TO_DATE');
      expect(report.matrix.getStatus('work-500', 'main-src-43')).toBe('TRANSIENT_ERROR');
    }
  });

  it('resumes interrupted cycle from 99% checkpoint executing only the remaining source, handles timeouts, immediate works, and popular fast-lane', async () => {
    const works = makeWorks(100);
    const sources = make43MainSources();
    const store = new InMemoryP0UniversalCheckpointStore();
    const fetchedOrder1: string[] = [];
    const scanner = new P0UniversalScanner(works, sources, {
      checkpointStore: store,
      pauseWindowMs: 120_000,
    });

    await expect(
      scanner.runCycle(
        {
          async fetchSourceCatalog(source) {
            fetchedOrder1.push(source.id);
            return { sourceId: source.id, outcome: 'OK_COMPLETE', items: [], httpCallsUsed: 1 };
          },
        },
        { simulateCrashAfterSources: 42 },
      ),
    ).rejects.toThrow('SIMULATED_CRASH_AFTER_42_SOURCES');

    expect(fetchedOrder1).toHaveLength(42);

    // Resume after crash: only source 43 runs!
    const fetchedOrder2: string[] = [];
    let sleepRecorded = 0;
    const resumedReport = await scanner.runCycle(
      {
        async fetchSourceCatalog(source) {
          fetchedOrder2.push(source.id);
          return { sourceId: source.id, outcome: 'OK_COMPLETE', items: [], httpCallsUsed: 1 };
        },
      },
      {
        sleepFn: async (ms) => {
          sleepRecorded = ms;
        },
      },
    );

    expect(resumedReport.resumedFromCheckpoint).toBe(true);
    expect(fetchedOrder2).toEqual(['main-src-43']);
    expect(resumedReport.evaluatedPairs).toBe(100 * 43);
    expect(sleepRecorded).toBe(120_000);

    // Enqueue a brand-new work -> immediate monitoring + included in next 43 x N cycle
    scanner.enqueueImmediateWork({ id: 'work-new-101', title: 'Nova Obra', slug: 'nova-obra' });
    expect(scanner.getImmediateQueueLength()).toBe(1);
    const drained = await scanner.drainImmediateMonitoringQueue({
      async fetchSourceCatalog() {
        return { sourceId: 'unused', outcome: 'OK_COMPLETE', items: [], httpCallsUsed: 0 };
      },
      async probeWorkDirect(work, source) {
        return {
          outcome: source.id === 'main-src-01' ? 'FOUND_NEW' : 'NOT_FOUND',
          latestOrderKey: 'n|000000000001.0000',
        };
      },
    });
    expect(drained[0]?.results['main-src-01']).toBe('NEW_CHAPTER_FOUND');

    // Popular fast-lane extra check + honest timeout test
    const fastLane = await scanner.runPopularFastLane(
      {
        async fetchSourceCatalog() {
          return { sourceId: 'unused', outcome: 'OK_COMPLETE', items: [], httpCallsUsed: 0 };
        },
        async probeWorkDirect(work, source) {
          return {
            outcome: work.id === 'work-0' && source.id === 'main-src-02' ? 'FOUND_NEW' : 'FOUND_SAME',
            latestOrderKey: 'n|000000000012.0000',
          };
        },
      },
      10,
    );
    expect(fastLane.checkedWorks).toBe(10);
    expect(fastLane.newReleases.some((r) => r.workId === 'work-0' && r.sourceId === 'main-src-02')).toBe(true);

    // Elastic cycle timeout finishes honestly with COMPLETED_WITH_PENDING
    let tick = 1000;
    const timedScanner = new P0UniversalScanner(works, sources, {
      maxCycleMs: 5000,
      pauseWindowMs: 0,
      now: () => tick,
    });
    const timedReport = await timedScanner.runCycle({
      async fetchSourceCatalog(source) {
        tick += 2000; // exceed 5000ms after 3 sources
        return { sourceId: source.id, outcome: 'OK_COMPLETE', items: [], httpCallsUsed: 1 };
      },
    });
    expect(timedReport.status).toBe('COMPLETED_WITH_PENDING');
    expect(timedReport.countsByStatus.PENDING_TIMEOUT).toBeGreaterThan(0);
  });
});
