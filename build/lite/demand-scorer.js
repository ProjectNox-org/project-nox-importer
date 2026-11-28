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
