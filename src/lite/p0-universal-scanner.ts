/**
 * Project Nox Importer Supremo V3.0 — P0 Universal 43 x N Scanner & Compact Matrix
 *
 * Guarantees in EVERY cycle:
 * - Every public canonical work (N) is evaluated against EVERY one of the 43 main sources.
 * - Never includes the 3 ALIAS_ONLY sources (mangaball, mangadex, mangafire).
 * - Uses O(1) normalized title/alias/slug matching against per-source complete catalog
 *   snapshots (zero forced 43 x N HTTP requests when full catalogs resolve pairs).
 * - Never fabricates NOT_FOUND_ON_SOURCE or UP_TO_DATE from blocked/429/partial catalogs.
 * - Uses compact Uint8Array (< 1 MiB for 23,000 x 43 = 989,000 pairs) to protect RAM.
 * - Supports elastic 30m target / 60m+ honest termination, 1-2m cooldown, crash checkpoint
 *   resume (e.g. 99% -> resume final 1%), immediate new-work monitoring, and popular fast-lane.
 */

import { ALIAS_ONLY_SOURCE_IDS } from '../alias-sources/types.js';
import { normalizeCatalogTitle, type CatalogItem } from './p0-cycle-coordinator.js';

export const P0_PAIR_STATUS_LIST = [
  'UNCHECKED',
  'NEW_CHAPTER_FOUND',
  'UP_TO_DATE',
  'NO_CHAPTERS_YET',
  'NOT_FOUND_ON_SOURCE',
  'SKIPPED_BLOCKED_SOURCE',
  'RATE_LIMITED',
  'TRANSIENT_ERROR',
  'PENDING_TIMEOUT',
] as const;

export type P0PairStatus = (typeof P0_PAIR_STATUS_LIST)[number];

export const P0_PAIR_CODE: Record<P0PairStatus, number> = {
  UNCHECKED: 0,
  NEW_CHAPTER_FOUND: 1,
  UP_TO_DATE: 2,
  NO_CHAPTERS_YET: 3,
  NOT_FOUND_ON_SOURCE: 4,
  SKIPPED_BLOCKED_SOURCE: 5,
  RATE_LIMITED: 6,
  TRANSIENT_ERROR: 7,
  PENDING_TIMEOUT: 8,
};

export interface CanonicalP0Work {
  id: string;
  title: string;
  slug: string;
  aliases?: readonly string[];
  popularScore?: number;
  knownLatestOrderBySource?: Readonly<Record<string, string>>;
}

export interface P0SourceDescriptor {
  id: string;
  status: 'HEALTHY' | 'DEGRADED' | 'RATE_LIMITED' | 'BLOCKED' | 'BROKEN';
  hasFullCatalogSupport?: boolean;
}

export interface P0CatalogItem extends CatalogItem {
  chapterCount?: number | null;
  latestChapter?: string | number | null;
}

export interface P0SourceCatalogFetchResult {
  sourceId: string;
  outcome: 'OK_COMPLETE' | 'OK_PARTIAL' | 'BLOCKED' | 'RATE_LIMITED' | 'TRANSIENT_ERROR' | 'TIMEOUT';
  items: readonly P0CatalogItem[];
  httpCallsUsed: number;
  expectedTotalItems?: number;
  previousItemCount?: number;
  errorDetail?: string;
}

export interface P0UniversalCatalogFetcher {
  fetchSourceCatalog(source: P0SourceDescriptor): Promise<P0SourceCatalogFetchResult>;
  probeWorkDirect?(work: CanonicalP0Work, source: P0SourceDescriptor): Promise<{
    outcome: 'FOUND_NEW' | 'FOUND_SAME' | 'FOUND_EMPTY' | 'NOT_FOUND' | 'BLOCKED' | 'RATE_LIMITED' | 'ERROR';
    latestOrderKey?: string;
    httpCallsUsed?: number;
  }>;
}

export interface P0UniversalCheckpoint {
  cycleId: string;
  status: 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'COMPLETED_WITH_PENDING';
  startedAt: string;
  completedAt: string | null;
  completedSources: string[];
  matrixBase64?: string;
  matrixStatuses?: number[];
  newChapterEvents: number;
  totalHttpCalls: number;
}

export interface P0UniversalCheckpointStore {
  loadLatest(): Promise<P0UniversalCheckpoint | null>;
  save(checkpoint: P0UniversalCheckpoint): Promise<void>;
}

export class InMemoryP0UniversalCheckpointStore implements P0UniversalCheckpointStore {
  private current: P0UniversalCheckpoint | null = null;
  async loadLatest(): Promise<P0UniversalCheckpoint | null> {
    return this.current ? structuredClone(this.current) : null;
  }
  async save(checkpoint: P0UniversalCheckpoint): Promise<void> {
    this.current = structuredClone(checkpoint);
  }
}

/**
 * Dense Uint8Array pair matrix: 1 byte per (work, source) evaluation.
 * 23,000 works * 43 sources = 989,000 bytes (< 1 MiB heap/external impact).
 */
export class CompactPairCoverageMatrix {
  readonly data: Uint8Array;
  private readonly workIdxById = new Map<string, number>();
  private readonly sourceIdxById = new Map<string, number>();

  constructor(
    readonly works: readonly CanonicalP0Work[],
    readonly sources: readonly P0SourceDescriptor[],
    initialData?: Uint8Array,
  ) {
    const expectedLen = works.length * sources.length;
    if (initialData && initialData.length === expectedLen) {
      this.data = new Uint8Array(initialData);
    } else {
      this.data = new Uint8Array(expectedLen);
    }
    works.forEach((w, i) => this.workIdxById.set(w.id, i));
    sources.forEach((s, j) => this.sourceIdxById.set(s.id, j));
  }

  setByIndex(workIdx: number, sourceIdx: number, status: P0PairStatus): void {
    this.data[workIdx * this.sources.length + sourceIdx] = P0_PAIR_CODE[status];
  }

  getByIndex(workIdx: number, sourceIdx: number): P0PairStatus {
    const code = this.data[workIdx * this.sources.length + sourceIdx] ?? 0;
    return P0_PAIR_STATUS_LIST[code] ?? 'UNCHECKED';
  }

  getStatus(workId: string, sourceId: string): P0PairStatus {
    const wi = this.workIdxById.get(workId);
    const si = this.sourceIdxById.get(sourceId);
    if (wi === undefined || si === undefined) return 'UNCHECKED';
    return this.getByIndex(wi, si);
  }

  fillSourceColumn(sourceIdx: number, status: P0PairStatus): void {
    const code = P0_PAIR_CODE[status];
    const stride = this.sources.length;
    for (let wi = 0; wi < this.works.length; wi++) {
      this.data[wi * stride + sourceIdx] = code;
    }
  }

  getCounts(): Record<P0PairStatus, number> {
    const counts: Record<P0PairStatus, number> = {
      UNCHECKED: 0,
      NEW_CHAPTER_FOUND: 0,
      UP_TO_DATE: 0,
      NO_CHAPTERS_YET: 0,
      NOT_FOUND_ON_SOURCE: 0,
      SKIPPED_BLOCKED_SOURCE: 0,
      RATE_LIMITED: 0,
      TRANSIENT_ERROR: 0,
      PENDING_TIMEOUT: 0,
    };
    for (let i = 0; i < this.data.length; i++) {
      const status = P0_PAIR_STATUS_LIST[this.data[i]] ?? 'UNCHECKED';
      counts[status] += 1;
    }
    return counts;
  }

  totalPairs(): number {
    return this.works.length * this.sources.length;
  }

  evaluatedPairs(): number {
    let n = 0;
    for (let i = 0; i < this.data.length; i++) {
      if (this.data[i] !== 0) n += 1;
    }
    return n;
  }
}

export interface P0UniversalCycleReport {
  cycleId: string;
  status: 'COMPLETED' | 'COMPLETED_WITH_PENDING';
  workCount: number;
  sourceCount: number;
  totalLogicalPairs: number;
  evaluatedPairs: number;
  httpCallsUsed: number;
  newChaptersFound: Array<{ workId: string; sourceId: string; latestOrderKey?: string }>;
  countsByStatus: Record<P0PairStatus, number>;
  pendingSources: string[];
  integrityAnomalies: Array<{ sourceId: string; reason: string }>;
  elapsedMs: number;
  pauseAppliedMs: number;
  resumedFromCheckpoint: boolean;
  matrix: CompactPairCoverageMatrix;
}

/**
 * Indexes canonical works by normalized title, aliases, and slug in O(M) memory
 * so streaming per-source catalog items resolve against all 10k-23k works in O(1).
 */
export class CompactCanonicalWorkIndex {
  private readonly keyToWorkIdx = new Map<string, number | -1>();

  constructor(readonly works: readonly CanonicalP0Work[]) {
    for (let wi = 0; wi < works.length; wi++) {
      const w = works[wi];
      const keys = new Set<string>();
      const add = (raw?: string | null) => {
        const k = normalizeCatalogTitle(raw);
        if (k) keys.add(k);
      };
      add(w.title);
      add(w.slug);
      for (const a of w.aliases ?? []) add(a);
      for (const key of keys) {
        const prev = this.keyToWorkIdx.get(key);
        if (prev === undefined) {
          this.keyToWorkIdx.set(key, wi);
        } else if (prev !== wi) {
          // Ambiguous title across two distinct canonical works: fail-closed (-1)
          this.keyToWorkIdx.set(key, -1);
        }
      }
    }
  }

  resolveItem(item: CatalogItem): number | null {
    const candidates = [item.title, item.slug, ...(item.aliases ?? [])];
    let resolvedIdx: number | null = null;
    for (const raw of candidates) {
      const k = normalizeCatalogTitle(raw);
      if (!k) continue;
      const idx = this.keyToWorkIdx.get(k);
      if (idx === undefined || idx === -1) continue;
      if (resolvedIdx !== null && resolvedIdx !== idx) {
        // Conflicting matches across candidate titles/aliases -> fail-closed
        return null;
      }
      resolvedIdx = idx;
    }
    return resolvedIdx;
  }
}

export interface P0UniversalScannerOptions {
  targetCycleMs?: number;
  maxCycleMs?: number;
  pauseWindowMs?: number;
  now?: () => number;
  checkpointStore?: P0UniversalCheckpointStore;
  directFallbackCapPerPartialSource?: number;
}

export class P0UniversalScanner {
  private readonly sources: P0SourceDescriptor[];
  private works: CanonicalP0Work[];
  private workIndex: CompactCanonicalWorkIndex;
  private readonly immediateMonitoringQueue: CanonicalP0Work[] = [];
  private readonly targetCycleMs: number;
  private readonly maxCycleMs: number;
  private readonly pauseWindowMs: number;
  private readonly now: () => number;
  private readonly checkpointStore: P0UniversalCheckpointStore;
  private readonly directFallbackCap: number;
  private cycleSeq = 0;

  constructor(
    initialWorks: readonly CanonicalP0Work[],
    mainSources: readonly P0SourceDescriptor[],
    options: P0UniversalScannerOptions = {},
  ) {
    const aliasLeak = mainSources.find((s) => (ALIAS_ONLY_SOURCE_IDS as readonly string[]).includes(s.id));
    if (aliasLeak) {
      throw new Error(`FORBIDDEN_ALIAS_SOURCE_IN_P0: ${aliasLeak.id}`);
    }
    if (mainSources.length === 0) {
      throw new Error('P0_REQUIRES_AT_LEAST_ONE_MAIN_SOURCE');
    }
    this.sources = [...mainSources];
    this.works = [...initialWorks];
    this.workIndex = new CompactCanonicalWorkIndex(this.works);
    this.targetCycleMs = options.targetCycleMs ?? 30 * 60 * 1000;
    this.maxCycleMs = options.maxCycleMs ?? 60 * 60 * 1000;
    this.pauseWindowMs = options.pauseWindowMs ?? 90 * 1000;
    this.now = options.now ?? (() => Date.now());
    this.checkpointStore = options.checkpointStore ?? new InMemoryP0UniversalCheckpointStore();
    this.directFallbackCap = options.directFallbackCapPerPartialSource ?? 25;
  }

  /** Updates the dynamic public catalog set (removing hardcoded 10_749 / 24_945 limits). */
  setCanonicalCatalog(works: readonly CanonicalP0Work[]): void {
    this.works = [...works];
    this.workIndex = new CompactCanonicalWorkIndex(this.works);
  }

  /**
   * Immediately registers a newly created work for monitoring right away
   * and ensures it is part of the next full 43 x N cycle.
   */
  enqueueImmediateWork(work: CanonicalP0Work): void {
    if (!this.works.some((w) => w.id === work.id)) {
      this.works.push(work);
      this.workIndex = new CompactCanonicalWorkIndex(this.works);
    }
    if (!this.immediateMonitoringQueue.some((w) => w.id === work.id)) {
      this.immediateMonitoringQueue.push(work);
    }
  }

  getImmediateQueueLength(): number {
    return this.immediateMonitoringQueue.length;
  }

  /** Immediately checks pending newly added works across healthy sources before/between full cycles. */
  async drainImmediateMonitoringQueue(fetcher: P0UniversalCatalogFetcher): Promise<Array<{
    workId: string;
    results: Record<string, P0PairStatus>;
  }>> {
    const drained: Array<{ workId: string; results: Record<string, P0PairStatus> }> = [];
    while (this.immediateMonitoringQueue.length > 0) {
      const work = this.immediateMonitoringQueue.shift()!;
      const results: Record<string, P0PairStatus> = {};
      for (const source of this.sources) {
        if (source.status === 'BLOCKED' || source.status === 'BROKEN') {
          results[source.id] = 'SKIPPED_BLOCKED_SOURCE';
          continue;
        }
        if (source.status === 'RATE_LIMITED') {
          results[source.id] = 'RATE_LIMITED';
          continue;
        }
        if (fetcher.probeWorkDirect) {
          const probe = await fetcher.probeWorkDirect(work, source);
          results[source.id] =
            probe.outcome === 'FOUND_NEW' ? 'NEW_CHAPTER_FOUND'
              : probe.outcome === 'FOUND_SAME' ? 'UP_TO_DATE'
                : probe.outcome === 'FOUND_EMPTY' ? 'NO_CHAPTERS_YET'
                  : probe.outcome === 'NOT_FOUND' ? 'NOT_FOUND_ON_SOURCE'
                    : probe.outcome === 'BLOCKED' ? 'SKIPPED_BLOCKED_SOURCE'
                      : probe.outcome === 'RATE_LIMITED' ? 'RATE_LIMITED'
                        : 'TRANSIENT_ERROR';
        } else {
          results[source.id] = 'TRANSIENT_ERROR';
        }
      }
      drained.push({ workId: work.id, results });
    }
    return drained;
  }

  /**
   * Popularity fast-lane: runs bounded extra update checks on the top K popular works
   * across healthy sources without ever dropping unpopular tail works from full 43 x N coverage.
   */
  async runPopularFastLane(
    fetcher: P0UniversalCatalogFetcher,
    topN = 50,
  ): Promise<{ checkedWorks: number; newReleases: Array<{ workId: string; sourceId: string; latestOrderKey?: string }> }> {
    const popular = [...this.works]
      .sort((a, b) => (b.popularScore ?? 0) - (a.popularScore ?? 0))
      .slice(0, topN);
    const newReleases: Array<{ workId: string; sourceId: string; latestOrderKey?: string }> = [];
    if (!fetcher.probeWorkDirect) return { checkedWorks: popular.length, newReleases };
    for (const work of popular) {
      for (const source of this.sources) {
        if (source.status !== 'HEALTHY') continue;
        const probe = await fetcher.probeWorkDirect(work, source);
        if (probe.outcome === 'FOUND_NEW') {
          newReleases.push({ workId: work.id, sourceId: source.id, latestOrderKey: probe.latestOrderKey });
        }
      }
    }
    return { checkedWorks: popular.length, newReleases };
  }

  /**
   * Executes or resumes a complete 43 x N evaluation cycle.
   * No negativeCacheTtlMs stale skips; every source-work pair receives a verifiable status.
   */
  async runCycle(
    fetcher: P0UniversalCatalogFetcher,
    options: { simulateCrashAfterSources?: number; sleepFn?: (ms: number) => Promise<void> } = {},
  ): Promise<P0UniversalCycleReport> {
    const t0 = this.now();
    const saved = await this.checkpointStore.loadLatest();
    const canResume = Boolean(
      saved &&
      saved.status === 'RUNNING' &&
      saved.matrixBase64 &&
      Buffer.from(saved.matrixBase64, 'base64').length === this.works.length * this.sources.length,
    );

    const cycleId = canResume ? saved!.cycleId : `p0-cycle-${++this.cycleSeq}-${t0}`;
    const initialBytes = canResume && saved?.matrixBase64
      ? new Uint8Array(Buffer.from(saved.matrixBase64, 'base64'))
      : undefined;
    const matrix = new CompactPairCoverageMatrix(this.works, this.sources, initialBytes);
    const completedSet = new Set<string>(canResume ? saved!.completedSources : []);
    let totalHttpCalls = canResume ? saved!.totalHttpCalls : 0;
    const newChaptersFound: Array<{ workId: string; sourceId: string; latestOrderKey?: string }> = [];
    const pendingSources: string[] = [];
    const integrityAnomalies: Array<{ sourceId: string; reason: string }> = [];
    let timedOut = false;

    for (let si = 0; si < this.sources.length; si++) {
      const source = this.sources[si];
      if (completedSet.has(source.id)) continue;

      if (this.now() - t0 >= this.maxCycleMs) {
        timedOut = true;
        for (let rem = si; rem < this.sources.length; rem++) {
          if (!completedSet.has(this.sources[rem].id)) {
            matrix.fillSourceColumn(rem, 'PENDING_TIMEOUT');
            pendingSources.push(this.sources[rem].id);
          }
        }
        break;
      }

      if (source.status === 'BLOCKED' || source.status === 'BROKEN') {
        matrix.fillSourceColumn(si, 'SKIPPED_BLOCKED_SOURCE');
        pendingSources.push(source.id);
        completedSet.add(source.id);
      } else if (source.status === 'RATE_LIMITED') {
        matrix.fillSourceColumn(si, 'RATE_LIMITED');
        pendingSources.push(source.id);
        completedSet.add(source.id);
      } else {
        const res = await fetcher.fetchSourceCatalog(source);
        totalHttpCalls += res.httpCallsUsed;

        let effectiveOutcome = res.outcome;
        if ((effectiveOutcome === 'OK_COMPLETE' || effectiveOutcome === 'OK_PARTIAL') && res.items.length === 0) {
          integrityAnomalies.push({
            sourceId: source.id,
            reason: `EMPTY_CATALOG_SUSPECT(${res.outcome})`,
          });
          effectiveOutcome = 'TRANSIENT_ERROR';
        } else if (effectiveOutcome === 'OK_COMPLETE') {
          const underExpected =
            res.expectedTotalItems !== undefined &&
            res.expectedTotalItems > 0 &&
            res.items.length < Math.floor(res.expectedTotalItems * 0.5);
          const sharpDrop =
            res.previousItemCount !== undefined &&
            res.previousItemCount >= 20 &&
            res.items.length < Math.floor(res.previousItemCount * 0.3);
          if (underExpected || sharpDrop) {
            integrityAnomalies.push({
              sourceId: source.id,
              reason: `SUSPECT_TRUNCATED_CATALOG(items=${res.items.length},expected=${res.expectedTotalItems ?? 'na'},prev=${res.previousItemCount ?? 'na'})`,
            });
            effectiveOutcome = 'OK_PARTIAL';
          }
        }

        if (effectiveOutcome === 'BLOCKED') {
          matrix.fillSourceColumn(si, 'SKIPPED_BLOCKED_SOURCE');
          pendingSources.push(source.id);
          completedSet.add(source.id);
        } else if (effectiveOutcome === 'RATE_LIMITED') {
          matrix.fillSourceColumn(si, 'RATE_LIMITED');
          pendingSources.push(source.id);
          completedSet.add(source.id);
        } else if (effectiveOutcome === 'TIMEOUT') {
          matrix.fillSourceColumn(si, 'PENDING_TIMEOUT');
          pendingSources.push(source.id);
          completedSet.add(source.id);
        } else if (effectiveOutcome === 'TRANSIENT_ERROR') {
          matrix.fillSourceColumn(si, 'TRANSIENT_ERROR');
          pendingSources.push(source.id);
          completedSet.add(source.id);
        } else {
          // OK_COMPLETE or OK_PARTIAL
          // First default every work in this source column strictly & honestly:
          // - OK_COMPLETE -> unmatched works are provably NOT_FOUND_ON_SOURCE
          // - OK_PARTIAL -> unmatched works MUST NOT be claimed NOT_FOUND_ON_SOURCE; mark TRANSIENT_ERROR unless verified by direct probe
          if (effectiveOutcome === 'OK_PARTIAL') {
            pendingSources.push(source.id);
          }
          const defaultUnmatched: P0PairStatus =
            effectiveOutcome === 'OK_COMPLETE' ? 'NOT_FOUND_ON_SOURCE' : 'TRANSIENT_ERROR';
          matrix.fillSourceColumn(si, defaultUnmatched);

          for (const item of res.items) {
            const wi = this.workIndex.resolveItem(item);
            if (wi === null) continue;
            const work = this.works[wi];
            const itemCount = item.chapterCount ?? null;
            const latestOrder = item.latestChapter ? String(item.latestChapter) : undefined;
            const knownLatest = work.knownLatestOrderBySource?.[source.id];

            if (itemCount === 0 && !latestOrder) {
              matrix.setByIndex(wi, si, 'NO_CHAPTERS_YET');
            } else if (latestOrder && knownLatest !== latestOrder) {
              matrix.setByIndex(wi, si, 'NEW_CHAPTER_FOUND');
              newChaptersFound.push({ workId: work.id, sourceId: source.id, latestOrderKey: latestOrder });
            } else {
              matrix.setByIndex(wi, si, 'UP_TO_DATE');
            }
          }

          if (effectiveOutcome === 'OK_PARTIAL' && fetcher.probeWorkDirect) {
            let directProbes = 0;
            for (let wi = 0; wi < this.works.length && directProbes < this.directFallbackCap; wi++) {
              if (matrix.getByIndex(wi, si) !== 'TRANSIENT_ERROR') continue;
              directProbes += 1;
              const p = await fetcher.probeWorkDirect(this.works[wi], source);
              totalHttpCalls += p.httpCallsUsed ?? 1;
              const mapped: P0PairStatus =
                p.outcome === 'FOUND_NEW' ? 'NEW_CHAPTER_FOUND'
                  : p.outcome === 'FOUND_SAME' ? 'UP_TO_DATE'
                    : p.outcome === 'FOUND_EMPTY' ? 'NO_CHAPTERS_YET'
                      : p.outcome === 'NOT_FOUND' ? 'NOT_FOUND_ON_SOURCE'
                        : p.outcome === 'BLOCKED' ? 'SKIPPED_BLOCKED_SOURCE'
                          : p.outcome === 'RATE_LIMITED' ? 'RATE_LIMITED'
                            : 'TRANSIENT_ERROR';
              matrix.setByIndex(wi, si, mapped);
              if (mapped === 'NEW_CHAPTER_FOUND') {
                newChaptersFound.push({ workId: this.works[wi].id, sourceId: source.id, latestOrderKey: p.latestOrderKey });
              }
            }
          }

          completedSet.add(source.id);
        }
      }

      // Persist incremental checkpoint after every source
      await this.checkpointStore.save({
        cycleId,
        status: 'RUNNING',
        startedAt: new Date(t0).toISOString(),
        completedAt: null,
        completedSources: [...completedSet],
        matrixBase64: Buffer.from(matrix.data).toString('base64'),
        newChapterEvents: newChaptersFound.length,
        totalHttpCalls,
      });

      if (
        options.simulateCrashAfterSources !== undefined &&
        completedSet.size >= options.simulateCrashAfterSources
      ) {
        throw new Error(`SIMULATED_CRASH_AFTER_${completedSet.size}_SOURCES`);
      }
    }

    const finalStatus: P0UniversalCycleReport['status'] =
      timedOut || pendingSources.length > 0
        ? 'COMPLETED_WITH_PENDING'
        : 'COMPLETED';
    const countsByStatus = matrix.getCounts();
    const elapsedMs = Math.max(0, this.now() - t0);

    await this.checkpointStore.save({
      cycleId,
      status: finalStatus,
      startedAt: new Date(t0).toISOString(),
      completedAt: new Date(this.now()).toISOString(),
      completedSources: [...completedSet],
      newChapterEvents: newChaptersFound.length,
      totalHttpCalls,
    });

    const pauseAppliedMs = this.pauseWindowMs;
    if (pauseAppliedMs > 0 && options.sleepFn) {
      await options.sleepFn(pauseAppliedMs);
    }

    return {
      cycleId,
      status: finalStatus,
      workCount: this.works.length,
      sourceCount: this.sources.length,
      totalLogicalPairs: matrix.totalPairs(),
      evaluatedPairs: matrix.evaluatedPairs(),
      httpCallsUsed: totalHttpCalls,
      newChaptersFound,
      countsByStatus,
      pendingSources: [...new Set(pendingSources)],
      integrityAnomalies,
      elapsedMs,
      pauseAppliedMs,
      resumedFromCheckpoint: canResume,
      matrix,
    };
  }

  /** Sub-ciclo rápido incremental sobre fontes saudáveis para detectar atualizações sem comprometer a cobertura 43 x N. */
  async runRecentUpdatesFastLane(
    fetcher: P0UniversalCatalogFetcher,
    options: { maxSources?: number } = {},
  ): Promise<{ inspectedSources: number; newChaptersFound: Array<{ workId: string; sourceId: string; latestOrderKey?: string }> }> {
    const healthySources = this.sources
      .filter((s) => s.status === 'HEALTHY')
      .slice(0, Math.max(1, options.maxSources ?? this.sources.length));
    const newChaptersFound: Array<{ workId: string; sourceId: string; latestOrderKey?: string }> = [];
    for (const source of healthySources) {
      const res = await fetcher.fetchSourceCatalog(source);
      if (res.outcome !== 'OK_COMPLETE' && res.outcome !== 'OK_PARTIAL') continue;
      if (res.items.length === 0) continue;
      for (const item of res.items) {
        const wi = this.workIndex.resolveItem(item);
        if (wi === null) continue;
        const work = this.works[wi];
        const latestOrder = item.latestChapter ? String(item.latestChapter) : undefined;
        const knownLatest = work.knownLatestOrderBySource?.[source.id];
        if (latestOrder && knownLatest !== latestOrder) {
          newChaptersFound.push({ workId: work.id, sourceId: source.id, latestOrderKey: latestOrder });
        }
      }
    }
    return {
      inspectedSources: healthySources.length,
      newChaptersFound,
    };
  }
}
