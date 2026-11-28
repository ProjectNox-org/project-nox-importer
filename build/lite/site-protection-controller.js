/**
 * Project Nox Importer Supremo V3.0 — Site Protection & Adaptive Backpressure Controller
 *
 * Protects Reader/API latency (p95/p99), PostgreSQL lock/pool health, and Discloud RSS
 * memory budget (624 MiB) by shedding non-urgent work in strict order:
 * P2 -> low-priority metadata -> P1 cohort/concurrency (keeping P0 fast-lane bounded).
 */
export class SiteProtectionController {
    lastLevel = 'NORMAL';
    evaluate(sample, nominalWorkers = 6) {
        const reasons = [];
        const rss = sample.rssMiB ?? 0;
        const pgLocks = sample.pgLocksWaiting ?? 0;
        const pgPoolWaiting = sample.pgPoolWaiting ?? 0;
        const err5xx = sample.reader5xxRate ?? 0;
        let p95Ratio = 1;
        if (sample.readerP95Ms && sample.baselineP95Ms && sample.baselineP95Ms > 0) {
            p95Ratio = sample.readerP95Ms / sample.baselineP95Ms;
        }
        let p99Ratio = 1;
        if (sample.readerP99Ms && sample.baselineP99Ms && sample.baselineP99Ms > 0) {
            p99Ratio = sample.readerP99Ms / sample.baselineP99Ms;
        }
        if (rss >= 540)
            reasons.push(`RSS_CRITICAL:${rss}MiB`);
        else if (rss >= 470)
            reasons.push(`RSS_HIGH:${rss}MiB`);
        if (pgLocks >= 3)
            reasons.push(`PG_LOCKS_CRITICAL:${pgLocks}`);
        else if (pgLocks >= 1)
            reasons.push(`PG_LOCKS_WAITING:${pgLocks}`);
        if (pgPoolWaiting >= 6)
            reasons.push(`PG_POOL_CRITICAL:${pgPoolWaiting}`);
        else if (pgPoolWaiting >= 2)
            reasons.push(`PG_POOL_WAITING:${pgPoolWaiting}`);
        if (err5xx > 0.01)
            reasons.push(`READER_5XX_REGRESSION:${(err5xx * 100).toFixed(2)}%`);
        if (p95Ratio > 1.15)
            reasons.push(`READER_P95_CRITICAL:+${Math.round((p95Ratio - 1) * 100)}%`);
        else if (p95Ratio > 1.05)
            reasons.push(`READER_P95_ELEVATED:+${Math.round((p95Ratio - 1) * 100)}%`);
        if (p99Ratio > 1.2)
            reasons.push(`READER_P99_CRITICAL:+${Math.round((p99Ratio - 1) * 100)}%`);
        else if (p99Ratio > 1.1)
            reasons.push(`READER_P99_ELEVATED:+${Math.round((p99Ratio - 1) * 100)}%`);
        const isCritical = rss >= 540 || pgLocks >= 3 || pgPoolWaiting >= 6 || err5xx > 0.01 || p95Ratio > 1.15 || p99Ratio > 1.2;
        const isElevated = !isCritical && reasons.length > 0;
        if (isCritical) {
            this.lastLevel = 'CRITICAL_PROTECT_SITE';
            return {
                level: 'CRITICAL_PROTECT_SITE',
                pauseP2Normal: true,
                pauseBackgroundMetadata: true,
                recommendedP1CohortSize: 5,
                recommendedChapterWorkerCap: Math.max(2, Math.floor(nominalWorkers * 0.35)),
                reasons,
            };
        }
        if (isElevated) {
            this.lastLevel = 'ELEVATED_PRESSURE';
            return {
                level: 'ELEVATED_PRESSURE',
                pauseP2Normal: true,
                pauseBackgroundMetadata: true,
                recommendedP1CohortSize: 7,
                recommendedChapterWorkerCap: Math.max(3, Math.floor(nominalWorkers * 0.65)),
                reasons,
            };
        }
        this.lastLevel = 'NORMAL';
        return {
            level: 'NORMAL',
            pauseP2Normal: false,
            pauseBackgroundMetadata: false,
            recommendedP1CohortSize: 10,
            recommendedChapterWorkerCap: nominalWorkers,
            reasons: [],
        };
    }
    getLastLevel() {
        return this.lastLevel;
    }
}
