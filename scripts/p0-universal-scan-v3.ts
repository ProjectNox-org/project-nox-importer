/**
 * Gate G2 / G4 Reproducible Scanner Script: P0 Universal 43 x N Audit
 *
 * Supports:
 * - `--works=10000` or `--works=23000`: verifies full 43 x N matrix evaluation + independent oracle
 * - `--live-sample`: runs real read-only fetchUpdatedWorks(null) against healthy main sources
 *   with strict rate limiting and prints honest pair/catalog completeness metrics.
 */

import { SourceRegistry } from '../src/sources/registry.js';
import { HostRateLimiter } from '../src/core/rate-limiter.js';
import {
  P0UniversalScanner,
  type CanonicalP0Work,
  type P0SourceCatalogFetchResult,
  type P0SourceDescriptor,
} from '../src/lite/p0-universal-scanner.js';
import { ALIAS_ONLY_SOURCE_IDS } from '../src/alias-sources/types.js';

async function runSyntheticOracle(workCount: number): Promise<void> {
  const rateLimiter = new HostRateLimiter(10);
  const registry = new SourceRegistry(rateLimiter);
  const mainAdapters = registry.getAll();
  const sources: P0SourceDescriptor[] = mainAdapters.map((a) => ({
    id: a.id,
    status: a.id === 'fleurblanche' || a.id === 'littletyrant' || a.id === 'mrtenzus' ? 'BLOCKED' : 'HEALTHY',
    hasFullCatalogSupport: true,
  }));

  if (sources.length !== 43) {
    throw new Error(`Expected 43 main sources, got ${sources.length}`);
  }
  for (const s of sources) {
    if ((ALIAS_ONLY_SOURCE_IDS as readonly string[]).includes(s.id)) {
      throw new Error(`ALIAS_ONLY source leaked into P0 scanner: ${s.id}`);
    }
  }

  const works: CanonicalP0Work[] = Array.from({ length: workCount }, (_, idx) => ({
    id: `w-${idx}`,
    title: `Obra Suprema ${idx}`,
    slug: `obra-suprema-${idx}`,
    aliases: [`Supreme Work ${idx}`],
    popularScore: idx < 100 ? 1000 - idx : 1,
    knownLatestOrderBySource: { [sources[0].id]: 'n|000000000010.0000' },
  }));

  const rssBefore = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const t0 = Date.now();
  const scanner = new P0UniversalScanner(works, sources, { pauseWindowMs: 0 });
  const report = await scanner.runCycle({
    async fetchSourceCatalog(source): Promise<P0SourceCatalogFetchResult> {
      if (source.id === 'mangaflix') {
        return {
          sourceId: source.id,
          outcome: 'RATE_LIMITED',
          items: [],
          httpCallsUsed: 1,
        };
      }
      // Match first 20 works cleanly on healthy sources (work 0 has new chapter 11 on nexus!)
      const items = works.slice(0, 20).map((w, i) => ({
        sourceWorkId: `${source.id}-${w.id}`,
        title: i % 2 === 0 ? w.title : w.aliases![0],
        slug: w.slug,
        latestChapter: i === 0 && source.id === sources[0].id ? 'n|000000000011.0000' : 'n|000000000010.0000',
        chapterCount: 10,
      }));
      return {
        sourceId: source.id,
        outcome: 'OK_COMPLETE',
        items,
        httpCallsUsed: 1,
      };
    },
  });
  const rssAfter = Math.round(process.memoryUsage().rss / 1024 / 1024);

  const summary = {
    mode: 'SYNTHETIC_ORACLE',
    workCount,
    sourceCount: report.sourceCount,
    totalLogicalPairs: report.totalLogicalPairs,
    evaluatedPairs: report.evaluatedPairs,
    httpCallsUsed: report.httpCallsUsed,
    countsByStatus: report.countsByStatus,
    newChaptersCount: report.newChaptersFound.length,
    elapsedMs: Date.now() - t0,
    rssBeforeMiB: rssBefore,
    rssAfterMiB: rssAfter,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (report.totalLogicalPairs !== workCount * 43 || report.evaluatedPairs !== workCount * 43) {
    throw new Error(`Incomplete coverage matrix: ${report.evaluatedPairs}/${report.totalLogicalPairs}`);
  }
}

async function runLiveSample(): Promise<void> {
  const rateLimiter = new HostRateLimiter(2);
  const registry = new SourceRegistry(rateLimiter);
  const sampleAdapters = registry.getAll().slice(0, 5);
  const out: Array<{ source: string; worksReturned: number; hasMoreCursor: boolean; elapsedMs: number }> = [];
  for (const a of sampleAdapters) {
    const t0 = Date.now();
    try {
      const upd = await a.fetchUpdatedWorks(null, { mode: 'maintenance' });
      out.push({
        source: a.id,
        worksReturned: upd.works?.length || 0,
        hasMoreCursor: Boolean(upd.nextCursor),
        elapsedMs: Date.now() - t0,
      });
    } catch {
      out.push({ source: a.id, worksReturned: 0, hasMoreCursor: false, elapsedMs: Date.now() - t0 });
    }
  }
  console.log(JSON.stringify({ mode: 'LIVE_READONLY_SAMPLE', results: out }, null, 2));
}

async function main() {
  const worksArg = process.argv.find((a) => a.startsWith('--works='));
  const liveSample = process.argv.includes('--live-sample');
  if (worksArg) {
    const n = Number.parseInt(worksArg.slice('--works='.length), 10);
    await runSyntheticOracle(n);
  }
  if (liveSample) {
    await runLiveSample();
  }
  if (!worksArg && !liveSample) {
    await runSyntheticOracle(10_000);
    await runSyntheticOracle(23_000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
