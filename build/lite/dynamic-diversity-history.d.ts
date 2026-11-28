/**
 * Project Nox Importer Supremo V3.0 — Dynamic Taxonomy Normalization & Persistent Cross-Cohort Diversity History
 *
 * Guarantees:
 * - Zero fixed genre/tag allowlist: any legitimate new genre/tag ingested by P2
 *   from PostgreSQL (`tags` / `work_tags`) automatically participates in P1/P2 diversity.
 * - Rejects only noise/placeholders/status labels/invalid markup/duplicates.
 * - Evaluates ALL legitimate tags of a work (no arbitrary 5-tag truncation) with
 *   sublinear credit so rare/novel tags at position 6..12+ still count meaningfully.
 * - Maintains a bounded decaying window across consecutive P1/P2 cohorts and persists
 *   compactly in PostgreSQL `settings` (`importer_v3_diversity_history_v1`), ensuring
 *   sustained rotation across genres, sources, kinds, ratings, and popularity tiers
 *   without rigid quotas or ever selecting blocked/non-executable works.
 */
export declare const DIVERSITY_HISTORY_SETTINGS_KEY = "importer_v3_diversity_history_v1";
/**
 * Dynamically normalizes any candidate genre/tag without a fixed allowlist.
 * Returns canonical lowercase hyphenated slug, or null if empty/noise/invalid.
 */
export declare function normalizeDynamicTaxonomyTag(raw: unknown): string | null;
/**
 * Normalizes and deduplicates ALL legitimate tags for a work without truncating at 5.
 */
export declare function normalizeDynamicTaxonomyTags(rawTags?: readonly unknown[] | null): string[];
export interface DiversitySelectionRecord {
    workId: string;
    selectedAtMs: number;
    source?: string | null;
    kind?: string | null;
    contentRating?: string | null;
    popularityTier?: string | null;
    genres: string[];
}
export interface DecayedDiversityProfile {
    totalWeight: number;
    distinctKnownGenres: number;
    distinctKnownSources: number;
    distinctKnownKinds: number;
    distinctKnownRatings: number;
    distinctKnownPopularities: number;
    genres: Record<string, number>;
    sources: Record<string, number>;
    kinds: Record<string, number>;
    contentRatings: Record<string, number>;
    popularityTiers: Record<string, number>;
}
export interface DiversityHistorySnapshot {
    version: 1;
    maxEntries: number;
    entryCount: number;
    distinctHistoricalGenres: number;
    distinctHistoricalSources: number;
    records: DiversitySelectionRecord[];
}
export interface CrossCohortCandidateDescriptor {
    genres?: readonly string[] | null;
    preNormalized?: boolean;
    source?: string | null;
    kind?: string | null;
    contentRating?: string | null;
    popularityTier?: string | null;
}
export interface CrossCohortCurrentMix {
    genreCounts?: ReadonlyMap<string, number>;
    sourceCounts?: ReadonlyMap<string, number>;
    kindCounts?: ReadonlyMap<string, number>;
    ratingCounts?: ReadonlyMap<string, number>;
    popularityCounts?: ReadonlyMap<string, number>;
}
export declare class DiversitySelectionHistory {
    private readonly maxEntries;
    private readonly decayFactor;
    private records;
    private versionCounter;
    constructor(options?: {
        maxEntries?: number;
        decayFactor?: number;
        initialRecords?: readonly DiversitySelectionRecord[];
    });
    getEntryCount(): number;
    getVersion(): number;
    recordSelection(record: DiversitySelectionRecord): void;
    recordCohortAdmissions(entries: readonly DiversitySelectionRecord[]): number;
    getDecayedProfile(): DecayedDiversityProfile;
    /**
     * Scores both current-cohort uniqueness and accumulated cross-cohort novelty/de-concentration
     * across ALL valid tags (dynamic, zero fixed list). Never rejects any candidate cleanly.
     */
    computeCrossCohortAdjustment(candidate: CrossCohortCandidateDescriptor, currentMix?: CrossCohortCurrentMix, profile?: DecayedDiversityProfile): {
        totalBonus: number;
        normalizedGenres: string[];
        unseenHistoricalGenreCount: number;
        rareHistoricalGenreCount: number;
    };
    getSnapshot(): DiversityHistorySnapshot;
    serialize(): string;
    static deserialize(raw: string | null | undefined, options?: {
        maxEntries?: number;
        decayFactor?: number;
    }): DiversitySelectionHistory;
}
