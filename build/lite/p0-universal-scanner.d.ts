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
import { type CatalogItem } from './p0-cycle-coordinator.js';
export declare const P0_PAIR_STATUS_LIST: readonly ["UNCHECKED", "NEW_CHAPTER_FOUND", "UP_TO_DATE", "NO_CHAPTERS_YET", "NOT_FOUND_ON_SOURCE", "SKIPPED_BLOCKED_SOURCE", "RATE_LIMITED", "TRANSIENT_ERROR", "PENDING_TIMEOUT"];
export type P0PairStatus = (typeof P0_PAIR_STATUS_LIST)[number];
export declare const P0_PAIR_CODE: Record<P0PairStatus, number>;
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
export declare class InMemoryP0UniversalCheckpointStore implements P0UniversalCheckpointStore {
    private current;
    loadLatest(): Promise<P0UniversalCheckpoint | null>;
    save(checkpoint: P0UniversalCheckpoint): Promise<void>;
}
/**
 * Dense Uint8Array pair matrix: 1 byte per (work, source) evaluation.
 * 23,000 works * 43 sources = 989,000 bytes (< 1 MiB heap/external impact).
 */
export declare class CompactPairCoverageMatrix {
    readonly works: readonly CanonicalP0Work[];
    readonly sources: readonly P0SourceDescriptor[];
    readonly data: Uint8Array;
    private readonly workIdxById;
    private readonly sourceIdxById;
    constructor(works: readonly CanonicalP0Work[], sources: readonly P0SourceDescriptor[], initialData?: Uint8Array);
    setByIndex(workIdx: number, sourceIdx: number, status: P0PairStatus): void;
    getByIndex(workIdx: number, sourceIdx: number): P0PairStatus;
    getStatus(workId: string, sourceId: string): P0PairStatus;
    fillSourceColumn(sourceIdx: number, status: P0PairStatus): void;
    getCounts(): Record<P0PairStatus, number>;
    totalPairs(): number;
    evaluatedPairs(): number;
}
export interface P0UniversalCycleReport {
    cycleId: string;
    status: 'COMPLETED' | 'COMPLETED_WITH_PENDING';
    workCount: number;
    sourceCount: number;
    totalLogicalPairs: number;
    evaluatedPairs: number;
    httpCallsUsed: number;
    newChaptersFound: Array<{
        workId: string;
        sourceId: string;
        latestOrderKey?: string;
    }>;
    countsByStatus: Record<P0PairStatus, number>;
    pendingSources: string[];
    integrityAnomalies: Array<{
        sourceId: string;
        reason: string;
    }>;
    elapsedMs: number;
    pauseAppliedMs: number;
    resumedFromCheckpoint: boolean;
    matrix: CompactPairCoverageMatrix;
}
/**
 * Indexes canonical works by normalized title, aliases, and slug in O(M) memory
 * so streaming per-source catalog items resolve against all 10k-23k works in O(1).
 */
export declare class CompactCanonicalWorkIndex {
    readonly works: readonly CanonicalP0Work[];
    private readonly keyToWorkIdx;
    constructor(works: readonly CanonicalP0Work[]);
    resolveItem(item: CatalogItem): number | null;
}
export interface P0UniversalScannerOptions {
    targetCycleMs?: number;
    maxCycleMs?: number;
    pauseWindowMs?: number;
    now?: () => number;
    checkpointStore?: P0UniversalCheckpointStore;
    directFallbackCapPerPartialSource?: number;
}
export declare class P0UniversalScanner {
    private readonly sources;
    private works;
    private workIndex;
    private readonly immediateMonitoringQueue;
    private readonly targetCycleMs;
    private readonly maxCycleMs;
    private readonly pauseWindowMs;
    private readonly now;
    private readonly checkpointStore;
    private readonly directFallbackCap;
    private cycleSeq;
    constructor(initialWorks: readonly CanonicalP0Work[], mainSources: readonly P0SourceDescriptor[], options?: P0UniversalScannerOptions);
    /** Updates the dynamic public catalog set (removing hardcoded 10_749 / 24_945 limits). */
    setCanonicalCatalog(works: readonly CanonicalP0Work[]): void;
    /**
     * Immediately registers a newly created work for monitoring right away
     * and ensures it is part of the next full 43 x N cycle.
     */
    enqueueImmediateWork(work: CanonicalP0Work): void;
    getImmediateQueueLength(): number;
    /** Immediately checks pending newly added works across healthy sources before/between full cycles. */
    drainImmediateMonitoringQueue(fetcher: P0UniversalCatalogFetcher): Promise<Array<{
        workId: string;
        results: Record<string, P0PairStatus>;
    }>>;
    /**
     * Popularity fast-lane: runs bounded extra update checks on the top K popular works
     * across healthy sources without ever dropping unpopular tail works from full 43 x N coverage.
     */
    runPopularFastLane(fetcher: P0UniversalCatalogFetcher, topN?: number): Promise<{
        checkedWorks: number;
        newReleases: Array<{
            workId: string;
            sourceId: string;
            latestOrderKey?: string;
        }>;
    }>;
    /**
     * Executes or resumes a complete 43 x N evaluation cycle.
     * No negativeCacheTtlMs stale skips; every source-work pair receives a verifiable status.
     */
    runCycle(fetcher: P0UniversalCatalogFetcher, options?: {
        simulateCrashAfterSources?: number;
        sleepFn?: (ms: number) => Promise<void>;
    }): Promise<P0UniversalCycleReport>;
    /** Sub-ciclo rápido incremental sobre fontes saudáveis para detectar atualizações sem comprometer a cobertura 43 x N. */
    runRecentUpdatesFastLane(fetcher: P0UniversalCatalogFetcher, options?: {
        maxSources?: number;
    }): Promise<{
        inspectedSources: number;
        newChaptersFound: Array<{
            workId: string;
            sourceId: string;
            latestOrderKey?: string;
        }>;
    }>;
}
