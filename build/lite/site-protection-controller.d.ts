/**
 * Project Nox Importer Supremo V3.0 — Site Protection & Adaptive Backpressure Controller
 *
 * Protects Reader/API latency (p95/p99), PostgreSQL lock/pool health, and Discloud RSS
 * memory budget (624 MiB) by shedding non-urgent work in strict order:
 * P2 -> low-priority metadata -> P1 cohort/concurrency (keeping P0 fast-lane bounded).
 */
export type SiteProtectionLevel = 'NORMAL' | 'ELEVATED_PRESSURE' | 'CRITICAL_PROTECT_SITE';
export interface SiteHealthSample {
    readerP95Ms?: number;
    baselineP95Ms?: number;
    readerP99Ms?: number;
    baselineP99Ms?: number;
    reader5xxRate?: number;
    pgLocksWaiting?: number;
    pgPoolWaiting?: number;
    rssMiB?: number;
}
export interface SiteProtectionDecision {
    level: SiteProtectionLevel;
    pauseP2Normal: boolean;
    pauseBackgroundMetadata: boolean;
    recommendedP1CohortSize: number;
    recommendedChapterWorkerCap: number;
    reasons: string[];
}
export declare class SiteProtectionController {
    private lastLevel;
    evaluate(sample: SiteHealthSample, nominalWorkers?: number): SiteProtectionDecision;
    getLastLevel(): SiteProtectionLevel;
}
