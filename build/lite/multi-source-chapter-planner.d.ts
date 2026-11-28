/**
 * Project Nox Importer Supremo V3.0 — 43-Source Multi-Source Chapter Planner
 *
 * Unifies chapter coverage across all 43 main sources (strictly isolating the
 * 3 ALIAS_ONLY sources: mangaball, mangadex, mangafire), maintains negative
 * NOT_FOUND cache with TTL recheck (never conflating UNAVAILABLE/BLOCKED with
 * NOT_FOUND), ranks the best source per chapter on integrity, resolution,
 * PT-BR priority, reliability, and sequence consistency without ever mixing
 * pages from divergent editions, and verifies true completion honestly.
 */
export declare function isAliasOnlySource(sourceId: string): boolean;
export type SourceObservationStatus = 'FOUND' | 'NOT_FOUND' | 'UNAVAILABLE' | 'BLOCKED' | 'RATE_LIMITED';
export interface WorkSourceObservation {
    workId: string;
    sourceId: string;
    status: SourceObservationStatus;
    observedAtMs?: number;
    detail?: string | null;
}
export interface NegativeCacheEntry {
    workId: string;
    sourceId: string;
    status: SourceObservationStatus;
    cachedAsNotFound: boolean;
    observedAtMs: number;
    expiresAtMs: number | null;
}
export interface ChapterCandidateFromSource {
    source: string;
    sourceWorkId?: string | null;
    sourceChapterId: string;
    canonicalChapterKey: string;
    displayNumber: string;
    language?: string | null;
    edition?: string | null;
    pageCount: number;
    avgWidthPx?: number | null;
    avgHeightPx?: number | null;
    filesAvailable?: boolean;
    broken?: boolean;
    sequenceConsistent?: boolean;
    contentFingerprint?: string | null;
    sourceHealth?: 'HEALTHY' | 'DEGRADED' | 'RATE_LIMITED' | 'BLOCKED' | 'BROKEN' | 'DISABLED';
    recentFailureRate?: number;
    consecutiveFailures?: number;
}
export interface ScoredSourceCandidate {
    source: string;
    score: number;
    eligible: boolean;
    rejectionReason: string | null;
}
export interface BestSourceChapterDecision {
    canonicalChapterKey: string;
    selected: ChapterCandidateFromSource | null;
    fallbackOrder: ChapterCandidateFromSource[];
    scoredCandidates: ScoredSourceCandidate[];
    excludedAliasOnlySources: string[];
    divergentEditionDetected: boolean;
    resolution: 'BEST_SOURCE_SELECTED' | 'DIVERGENT_CONTENT_PRESERVED' | 'ALL_SOURCES_BLOCKED_OR_UNAVAILABLE' | 'NO_ELIGIBLE_SOURCE';
}
export interface WorkCoveragePlanInput {
    workId: string;
    publishedVerifiedKeys: ReadonlySet<string> | readonly string[];
    brokenPublishedKeys?: ReadonlySet<string> | readonly string[];
    manifestsBySource: Readonly<Record<string, readonly ChapterCandidateFromSource[]>>;
    sourceStates?: Readonly<Record<string, SourceObservationStatus>>;
}
export interface WorkCoveragePlan {
    workId: string;
    knownCanonicalKeys: string[];
    knownMaxChapterCount: number;
    skippedAlreadyPublishedKeys: string[];
    executablePlans: BestSourceChapterDecision[];
    blockedChapterKeys: string[];
    sourcesUsed: string[];
    aliasOnlyRejectedSources: string[];
}
export type WorkCoverageCompletionStatus = 'COMPLETED_KNOWN_COVERAGE' | 'PARTIAL_WITH_BLOCKED_GAPS' | 'IN_PROGRESS';
export interface WorkCoverageCompletionInput {
    workId: string;
    knownCanonicalKeys: readonly string[];
    publishedVerifiedKeys: ReadonlySet<string> | readonly string[];
    blockedChapterKeys?: ReadonlySet<string> | readonly string[];
    unverifiedPublishedKeys?: ReadonlySet<string> | readonly string[];
    pendingTaskCount?: number;
}
export interface WorkCoverageCompletionResult {
    workId: string;
    status: WorkCoverageCompletionStatus;
    completed: boolean;
    keepInP0Monitoring: true;
    knownChapterCount: number;
    publishedVerifiedCount: number;
    missingExecutableKeys: string[];
    blockedChapterKeys: string[];
    unverifiedPublishedKeys: string[];
    pendingTaskCount: number;
}
export declare class MultiSourceChapterPlanner {
    private readonly negativeCache;
    private readonly lastObservation;
    private readonly canonicalWorkByNormTitle;
    private readonly aliasesByWorkId;
    private readonly negativeCacheTtlMs;
    constructor(options?: {
        negativeCacheTtlMs?: number;
    });
    /** Registers a canonical work + all known title variants across the 43+3 sources for O(1) resolution. */
    registerWorkAliases(workId: string, titles: readonly string[]): void;
    resolveCanonicalWorkId(candidateTitles: readonly string[]): string | null;
    /**
     * Records a source observation for a work. Only true NOT_FOUND enters the negative cache;
     * UNAVAILABLE, BLOCKED, and RATE_LIMITED never mark a source as NOT_FOUND.
     */
    recordSourceObservation(obs: WorkSourceObservation): NegativeCacheEntry | null;
    getNegativeCacheEntry(workId: string, sourceId: string): NegativeCacheEntry | null;
    shouldSkipSourceCheck(workId: string, sourceId: string, nowMs?: number): boolean;
    /** Ranks eligible main sources for one chapter key without ever mixing pages across divergent editions. */
    selectBestSourceForChapter(canonicalChapterKey: string, rawCandidates: readonly ChapterCandidateFromSource[], options?: {
        preferredSources?: readonly string[];
    }): BestSourceChapterDecision;
    /**
     * Computes full multi-source coverage across all confirmed main sources (excluding ALIAS_ONLY),
     * skips already-published intact chapters, plans missing gaps using the best source per chapter,
     * and separates genuinely blocked gaps from executable work.
     */
    planMissingChaptersForWork(input: WorkCoveragePlanInput): WorkCoveragePlan;
    /**
     * Verifies whether a work truly finished all known coverage.
     * Never reports false completion when blocked gaps or unverified/pending chapters remain.
     */
    evaluateWorkCoverageCompletion(input: WorkCoverageCompletionInput): WorkCoverageCompletionResult;
}
