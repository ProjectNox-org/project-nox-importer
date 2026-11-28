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
import { normalizeDynamicTaxonomyTags, } from './dynamic-diversity-history.js';
export function scoreWorkDemand(signals) {
    const safe24 = Math.max(0, signals.views24h || 0);
    const safe7d = Math.max(0, signals.views7d || 0);
    const safe30d = Math.max(0, signals.views30d || 0);
    // Anti-fraud: bound each reader to max 3 counted views in 24h / 10 in 7d when uniqueReaders is supplied
    const cap24 = signals.uniqueReaders24h !== undefined ? Math.max(1, signals.uniqueReaders24h) * 3 : safe24;
    const cap7d = signals.uniqueReaders7d !== undefined ? Math.max(1, signals.uniqueReaders7d) * 10 : safe7d;
    const effectiveViews24h = Math.min(safe24, cap24);
    const effectiveViews7d = Math.min(safe7d, cap7d);
    const fraudDampened = effectiveViews24h < safe24 || effectiveViews7d < safe7d;
    // Log-normalized weighted popularity curve so massive hits dominate without completely crushing mid-tier
    const d24 = Math.log1p(effectiveViews24h) * 18 * 0.5;
    const d7 = Math.log1p(effectiveViews7d) * 14 * 0.3;
    const d30 = Math.log1p(safe30d) * 10 * 0.15;
    const demandComponent = Number((d24 + d7 + d30).toFixed(4));
    // Works with a pending P0 release behind incomplete P1 predecessors get top unblocking weight
    const unlockBonus = signals.hasP0NewReleaseBlocked ? 120 : 0;
    // Near-completion bonus (rewards clearing 1-5 remaining chapters quickly)
    const remaining = Math.max(0, (signals.totalManifestChapters || 0) - (signals.publishedChapters || 0));
    const completionBonus = remaining > 0 && remaining <= 5 ? 30 - remaining * 4
        : signals.totalManifestChapters > 0
            ? Math.min(18, (signals.publishedChapters / signals.totalManifestChapters) * 18)
            : 0;
    // Aging prevents permanent tail starvation
    const agingBonus = Math.min(45, Math.max(0, signals.hoursWaitingInQueue || 0) * 0.5);
    const rawScore = demandComponent + unlockBonus + completionBonus + agingBonus;
    const hysteresisBonus = signals.currentlyInCohort ? Number((rawScore * 0.1).toFixed(4)) : 0;
    return {
        workId: signals.workId,
        score: Number((rawScore + hysteresisBonus).toFixed(4)),
        effectiveViews24h,
        effectiveViews7d,
        fraudDampened,
        breakdown: {
            demandComponent,
            unlockBonus,
            completionBonus: Number(completionBonus.toFixed(4)),
            agingBonus: Number(agingBonus.toFixed(4)),
            hysteresisBonus,
        },
    };
}
export function selectFocusedP1Cohort(candidates, targetCohortSize = 10) {
    const clampedTarget = Math.max(5, Math.min(10, Math.floor(targetCohortSize)));
    const ranked = candidates
        .map(scoreWorkDemand)
        .sort((a, b) => b.score - a.score || a.workId.localeCompare(b.workId));
    return {
        selectedIds: ranked.slice(0, clampedTarget).map((r) => r.workId),
        ranked,
    };
}
export function classifyPopularityTier(views7d, views30d) {
    const ref = Math.max(views7d || 0, (views30d || 0) * 0.25);
    if (ref >= 1000)
        return 'HIGH';
    if (ref >= 100)
        return 'MID';
    return 'TAIL';
}
export function classifyMissingBucket(remaining) {
    if (remaining <= 5)
        return 'NEAR_DONE';
    if (remaining <= 25)
        return 'MEDIUM';
    return 'LARGE';
}
function normVal(val, fallback = 'unknown') {
    const s = String(val || '').trim().toLowerCase();
    return s || fallback;
}
export function selectDiverseP1Cohort(candidates, openSlots, options = {}) {
    const targetPick = Math.max(0, Math.floor(openSlots));
    const randomFn = options.randomFn ?? Math.random;
    const jitterPoints = Math.max(0, options.jitterPoints ?? 12);
    const histProfile = options.history ? options.history.getDecayedProfile() : null;
    const genreCounts = new Map();
    const kindCounts = new Map();
    const ratingCounts = new Map();
    const sourceCounts = new Map();
    const popularityCounts = new Map();
    const missingCounts = new Map();
    const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
    const recordWork = (w) => {
        for (const g of normalizeDynamicTaxonomyTags(w.genres)) {
            bump(genreCounts, g);
        }
        if (w.kind)
            bump(kindCounts, normVal(w.kind));
        if (w.contentRating)
            bump(ratingCounts, normVal(w.contentRating));
        const src = w.primarySource || w.availableSources?.[0];
        if (src)
            bump(sourceCounts, normVal(src));
        bump(popularityCounts, classifyPopularityTier(w.views7d, w.views30d));
        const remaining = Math.max(1, (w.totalManifestChapters || 0) - (w.publishedChapters || 0));
        bump(missingCounts, classifyMissingBucket(remaining));
    };
    for (const w of options.existingCohort || []) {
        recordWork(w);
    }
    const baseScores = new Map();
    const cleanGenresById = new Map();
    for (const c of candidates) {
        baseScores.set(c.workId, scoreWorkDemand(c));
        cleanGenresById.set(c.workId, normalizeDynamicTaxonomyTags(c.genres));
    }
    const pool = [...candidates];
    const jitterById = new Map();
    for (const c of pool) {
        jitterById.set(c.workId, randomFn() * jitterPoints);
    }
    const selectedIds = [];
    const ranked = [];
    while (selectedIds.length < targetPick && pool.length > 0) {
        let bestIdx = 0;
        let bestScore = -Infinity;
        for (let i = 0; i < pool.length; i++) {
            const c = pool[i];
            const base = baseScores.get(c.workId).score;
            let divBonus = 0;
            const genres = cleanGenresById.get(c.workId) || [];
            if (genres.length > 0) {
                let unseenGenres = 0;
                for (const g of genres) {
                    if ((genreCounts.get(g) ?? 0) === 0)
                        unseenGenres++;
                }
                // Evaluates ALL normalized tags (beyond tag #5) with sublinear scaling
                if (unseenGenres > 0) {
                    divBonus += Math.min(34, 16 + (unseenGenres / Math.sqrt(genres.length)) * 8);
                }
            }
            if (c.kind) {
                const kCount = kindCounts.get(normVal(c.kind)) ?? 0;
                divBonus += kCount === 0 ? 22 : kCount === 1 ? 8 : 0;
            }
            if (c.contentRating) {
                const rCount = ratingCounts.get(normVal(c.contentRating)) ?? 0;
                divBonus += rCount === 0 ? 20 : rCount === 1 ? 7 : 0;
            }
            const src = c.primarySource || c.availableSources?.[0];
            if (src) {
                const sCount = sourceCounts.get(normVal(src)) ?? 0;
                divBonus += sCount === 0 ? 24 : sCount === 1 ? 8 : -sCount * 4;
            }
            const popTier = classifyPopularityTier(c.views7d, c.views30d);
            divBonus += (popularityCounts.get(popTier) ?? 0) === 0 ? 12 : 0;
            const remaining = Math.max(1, (c.totalManifestChapters || 0) - (c.publishedChapters || 0));
            const missBucket = classifyMissingBucket(remaining);
            divBonus += (missingCounts.get(missBucket) ?? 0) === 0 ? 10 : 0;
            const crossCohortDelta = options.history && histProfile
                ? options.history.computeCrossCohortAdjustment({
                    genres,
                    preNormalized: true,
                    source: src ?? null,
                    kind: c.kind ?? null,
                    contentRating: c.contentRating ?? null,
                    popularityTier: popTier,
                }, { genreCounts, sourceCounts, kindCounts, ratingCounts, popularityCounts }, histProfile).totalBonus
                : 0;
            const total = base + divBonus + crossCohortDelta + (jitterById.get(c.workId) ?? 0);
            if (total > bestScore) {
                bestScore = total;
                bestIdx = i;
            }
        }
        const chosen = pool.splice(bestIdx, 1)[0];
        selectedIds.push(chosen.workId);
        ranked.push(baseScores.get(chosen.workId));
        recordWork(chosen);
    }
    for (const rem of pool) {
        ranked.push(baseScores.get(rem.workId));
    }
    return { selectedIds, ranked };
}
