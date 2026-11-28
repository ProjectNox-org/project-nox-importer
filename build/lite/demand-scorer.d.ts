/**
 * Project Nox Importer Supremo V3.0 — Real Demand & Priority Scorer (Parte 09)
 *
 * Balances 24h / 7d / 30d reader activity against:
 * - Anti-fraud dampening (caps single-reader reload floods relative to uniqueReaders)
 * - Completion proximity (prefers nearly-finished works so P1 slots free rapidly)
 * - P0 unlock bonus (prioritizes incomplete works blocking urgent P0 chapters)
 * - Anti-starvation aging for older tail works
 * - Hysteresis (+10%) to avoid churning focused cohort works unnecessarily
 */
export interface WorkDemandSignals {
    workId: string;
    views24h: number;
    views7d: number;
    views30d: number;
    uniqueReaders24h?: number;
    uniqueReaders7d?: number;
    publishedChapters: number;
    totalManifestChapters: number;
    hasP0NewReleaseBlocked: boolean;
    hoursWaitingInQueue: number;
    currentlyInCohort?: boolean;
}
export interface DemandScoreResult {
    workId: string;
    score: number;
    effectiveViews24h: number;
    effectiveViews7d: number;
    fraudDampened: boolean;
    breakdown: {
        demandComponent: number;
        unlockBonus: number;
        completionBonus: number;
        agingBonus: number;
        hysteresisBonus: number;
    };
}
export declare function scoreWorkDemand(signals: WorkDemandSignals): DemandScoreResult;
export declare function selectFocusedP1Cohort(candidates: readonly WorkDemandSignals[], targetCohortSize?: number): {
    selectedIds: string[];
    ranked: DemandScoreResult[];
};
