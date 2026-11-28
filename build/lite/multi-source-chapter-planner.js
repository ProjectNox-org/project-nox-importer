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
import { ALIAS_ONLY_SOURCE_IDS } from '../alias-sources/types.js';
import { normalizeCatalogTitle } from './p0-cycle-coordinator.js';
const ALIAS_ONLY_SET = new Set(ALIAS_ONLY_SOURCE_IDS);
export function isAliasOnlySource(sourceId) {
    return ALIAS_ONLY_SET.has(String(sourceId || '').trim().toLowerCase());
}
function toSet(input) {
    if (!input)
        return new Set();
    return input instanceof Set ? new Set(input) : new Set(input);
}
function languageScore(lang) {
    const norm = String(lang || '').trim().toLowerCase();
    if (norm === 'pt-br' || norm === 'pt_br' || norm === 'ptbr')
        return 40;
    if (norm === 'pt')
        return 30;
    if (norm === 'en' || norm === 'en-us')
        return 14;
    return 6;
}
function resolutionScore(w, h) {
    const width = Math.max(0, Number(w || 0));
    const height = Math.max(0, Number(h || 0));
    if (width <= 0 && height <= 0)
        return 10; // Unknown dimensions remain neutral rather than broken
    if (width >= 900 || height >= 1200)
        return 26;
    if (width >= 720 || height >= 1000)
        return 20;
    if (width >= 550)
        return 12;
    return 2;
}
export class MultiSourceChapterPlanner {
    negativeCache = new Map();
    lastObservation = new Map();
    canonicalWorkByNormTitle = new Map();
    aliasesByWorkId = new Map();
    negativeCacheTtlMs;
    constructor(options = {}) {
        this.negativeCacheTtlMs = Math.max(60_000, options.negativeCacheTtlMs ?? 6 * 3_600_000);
    }
    /** Registers a canonical work + all known title variants across the 43+3 sources for O(1) resolution. */
    registerWorkAliases(workId, titles) {
        let set = this.aliasesByWorkId.get(workId);
        if (!set) {
            set = new Set();
            this.aliasesByWorkId.set(workId, set);
        }
        for (const raw of titles) {
            const norm = normalizeCatalogTitle(String(raw || ''));
            if (!norm)
                continue;
            set.add(norm);
            if (!this.canonicalWorkByNormTitle.has(norm)) {
                this.canonicalWorkByNormTitle.set(norm, workId);
            }
        }
    }
    resolveCanonicalWorkId(candidateTitles) {
        for (const raw of candidateTitles) {
            const norm = normalizeCatalogTitle(String(raw || ''));
            if (!norm)
                continue;
            const found = this.canonicalWorkByNormTitle.get(norm);
            if (found)
                return found;
        }
        return null;
    }
    /**
     * Records a source observation for a work. Only true NOT_FOUND enters the negative cache;
     * UNAVAILABLE, BLOCKED, and RATE_LIMITED never mark a source as NOT_FOUND.
     */
    recordSourceObservation(obs) {
        const sourceId = String(obs.sourceId || '').trim().toLowerCase();
        if (!sourceId || isAliasOnlySource(sourceId))
            return null;
        const nowMs = obs.observedAtMs ?? Date.now();
        const key = `${obs.workId}::${sourceId}`;
        this.lastObservation.set(key, { ...obs, sourceId, observedAtMs: nowMs });
        if (obs.status === 'NOT_FOUND') {
            const entry = {
                workId: obs.workId,
                sourceId,
                status: 'NOT_FOUND',
                cachedAsNotFound: true,
                observedAtMs: nowMs,
                expiresAtMs: nowMs + this.negativeCacheTtlMs,
            };
            this.negativeCache.set(key, entry);
            return entry;
        }
        if (obs.status === 'FOUND') {
            this.negativeCache.delete(key);
            return null;
        }
        // UNAVAILABLE / BLOCKED / RATE_LIMITED: never persist a negative NOT_FOUND cache entry
        return {
            workId: obs.workId,
            sourceId,
            status: obs.status,
            cachedAsNotFound: false,
            observedAtMs: nowMs,
            expiresAtMs: null,
        };
    }
    getNegativeCacheEntry(workId, sourceId) {
        return this.negativeCache.get(`${workId}::${String(sourceId || '').toLowerCase()}`) ?? null;
    }
    shouldSkipSourceCheck(workId, sourceId, nowMs = Date.now()) {
        const normSource = String(sourceId || '').trim().toLowerCase();
        if (isAliasOnlySource(normSource))
            return true;
        const cached = this.negativeCache.get(`${workId}::${normSource}`);
        if (!cached || !cached.cachedAsNotFound || cached.expiresAtMs === null)
            return false;
        if (nowMs >= cached.expiresAtMs) {
            // TTL expired -> allow clean recheck
            this.negativeCache.delete(`${workId}::${normSource}`);
            return false;
        }
        return true;
    }
    /** Ranks eligible main sources for one chapter key without ever mixing pages across divergent editions. */
    selectBestSourceForChapter(canonicalChapterKey, rawCandidates, options = {}) {
        const excludedAliasOnlySources = [];
        const usableCandidates = [];
        for (const c of rawCandidates) {
            const src = String(c.source || '').trim().toLowerCase();
            if (!src)
                continue;
            if (isAliasOnlySource(src)) {
                if (!excludedAliasOnlySources.includes(src))
                    excludedAliasOnlySources.push(src);
                continue;
            }
            usableCandidates.push({ ...c, source: src });
        }
        const healthyPageCounts = usableCandidates
            .filter((c) => !c.broken && c.filesAvailable !== false && c.pageCount > 0 && c.sourceHealth !== 'BLOCKED' && c.sourceHealth !== 'BROKEN' && c.sourceHealth !== 'DISABLED' && c.sourceHealth !== 'RATE_LIMITED')
            .map((c) => c.pageCount)
            .sort((a, b) => a - b);
        const medianPeers = healthyPageCounts.length > 0
            ? healthyPageCounts[Math.floor(healthyPageCounts.length / 2)]
            : 0;
        const minValidPages = healthyPageCounts.length > 0 ? healthyPageCounts[0] : 0;
        const maxValidPages = healthyPageCounts.length > 0 ? healthyPageCounts[healthyPageCounts.length - 1] : 0;
        const fingerprints = new Set(usableCandidates
            .map((c) => c.contentFingerprint?.trim())
            .filter((fp) => Boolean(fp)));
        const divergentEditionDetected = fingerprints.size > 1 ||
            (healthyPageCounts.length >= 2 && minValidPages > 0 && maxValidPages > Math.ceil(minValidPages * 1.35));
        const preferredSet = new Set((options.preferredSources || []).map((s) => s.toLowerCase()));
        const scoredCandidates = [];
        const rankedEligible = [];
        for (const cand of usableCandidates) {
            const health = cand.sourceHealth ?? 'HEALTHY';
            if (health === 'BLOCKED' || health === 'BROKEN' || health === 'DISABLED' || health === 'RATE_LIMITED') {
                scoredCandidates.push({ source: cand.source, score: -1, eligible: false, rejectionReason: `SOURCE_${health}` });
                continue;
            }
            if (cand.broken || cand.filesAvailable === false || cand.pageCount <= 0) {
                scoredCandidates.push({ source: cand.source, score: -1, eligible: false, rejectionReason: 'BROKEN_OR_EMPTY_CHAPTER' });
                continue;
            }
            const isTruncatedRelativeToPeers = medianPeers >= 6 && cand.pageCount < Math.floor(medianPeers * 0.6);
            const healthScore = health === 'HEALTHY' ? 35 : 15;
            const reliabilityPenalty = Math.min(35, Math.max(0, cand.recentFailureRate ?? 0) * 40 + Math.max(0, cand.consecutiveFailures ?? 0) * 5);
            const pageCompletenessScore = isTruncatedRelativeToPeers ? -60 : Math.min(30, cand.pageCount * 1.2);
            const sequenceBonus = cand.sequenceConsistent === false ? -25 : 10;
            const preferredBonus = preferredSet.has(cand.source) ? 4 : 0;
            const totalScore = Number((healthScore +
                languageScore(cand.language) +
                resolutionScore(cand.avgWidthPx, cand.avgHeightPx) +
                pageCompletenessScore +
                sequenceBonus +
                preferredBonus -
                reliabilityPenalty).toFixed(4));
            scoredCandidates.push({
                source: cand.source,
                score: totalScore,
                eligible: true,
                rejectionReason: isTruncatedRelativeToPeers ? 'LOW_PAGE_COUNT_PENALIZED' : null,
            });
            rankedEligible.push({ candidate: cand, score: totalScore });
        }
        rankedEligible.sort((a, b) => b.score - a.score || b.candidate.pageCount - a.candidate.pageCount || a.candidate.source.localeCompare(b.candidate.source));
        const selected = rankedEligible[0]?.candidate ?? null;
        if (!selected) {
            const hadBlockedOrUnavailable = scoredCandidates.some((s) => s.rejectionReason?.startsWith('SOURCE_'));
            return {
                canonicalChapterKey,
                selected: null,
                fallbackOrder: [],
                scoredCandidates,
                excludedAliasOnlySources,
                divergentEditionDetected,
                resolution: hadBlockedOrUnavailable ? 'ALL_SOURCES_BLOCKED_OR_UNAVAILABLE' : 'NO_ELIGIBLE_SOURCE',
            };
        }
        return {
            canonicalChapterKey,
            selected,
            fallbackOrder: rankedEligible.map((r) => r.candidate),
            scoredCandidates,
            excludedAliasOnlySources,
            divergentEditionDetected,
            resolution: divergentEditionDetected ? 'DIVERGENT_CONTENT_PRESERVED' : 'BEST_SOURCE_SELECTED',
        };
    }
    /**
     * Computes full multi-source coverage across all confirmed main sources (excluding ALIAS_ONLY),
     * skips already-published intact chapters, plans missing gaps using the best source per chapter,
     * and separates genuinely blocked gaps from executable work.
     */
    planMissingChaptersForWork(input) {
        const publishedSet = toSet(input.publishedVerifiedKeys);
        const brokenPublishedSet = toSet(input.brokenPublishedKeys);
        const aliasOnlyRejectedSources = [];
        const byChapterKey = new Map();
        const activeContributingSources = new Set();
        for (const [rawSource, chapters] of Object.entries(input.manifestsBySource)) {
            const source = String(rawSource || '').trim().toLowerCase();
            if (!source)
                continue;
            if (isAliasOnlySource(source)) {
                if (!aliasOnlyRejectedSources.includes(source))
                    aliasOnlyRejectedSources.push(source);
                continue;
            }
            const state = input.sourceStates?.[source] ?? input.sourceStates?.[rawSource];
            if (state) {
                this.recordSourceObservation({ workId: input.workId, sourceId: source, status: state });
            }
            activeContributingSources.add(source);
            for (const chap of chapters) {
                const key = String(chap.canonicalChapterKey || '').trim();
                if (!key)
                    continue;
                const list = byChapterKey.get(key) ?? [];
                list.push({
                    ...chap,
                    source,
                    sourceHealth: state === 'BLOCKED' || state === 'UNAVAILABLE'
                        ? 'BLOCKED'
                        : state === 'RATE_LIMITED'
                            ? 'RATE_LIMITED'
                            : chap.sourceHealth,
                });
                byChapterKey.set(key, list);
            }
        }
        const knownCanonicalKeys = [...byChapterKey.keys()].sort();
        const skippedAlreadyPublishedKeys = [];
        const executablePlans = [];
        const blockedChapterKeys = [];
        const sourcesUsed = new Set();
        for (const key of knownCanonicalKeys) {
            if (publishedSet.has(key) && !brokenPublishedSet.has(key)) {
                skippedAlreadyPublishedKeys.push(key);
                continue;
            }
            const decision = this.selectBestSourceForChapter(key, byChapterKey.get(key) || []);
            if (decision.selected) {
                executablePlans.push(decision);
                sourcesUsed.add(decision.selected.source);
            }
            else {
                blockedChapterKeys.push(key);
            }
        }
        return {
            workId: input.workId,
            knownCanonicalKeys,
            knownMaxChapterCount: knownCanonicalKeys.length,
            skippedAlreadyPublishedKeys,
            executablePlans,
            blockedChapterKeys,
            sourcesUsed: [...sourcesUsed],
            aliasOnlyRejectedSources,
        };
    }
    /**
     * Verifies whether a work truly finished all known coverage.
     * Never reports false completion when blocked gaps or unverified/pending chapters remain.
     */
    evaluateWorkCoverageCompletion(input) {
        const publishedSet = toSet(input.publishedVerifiedKeys);
        const blockedSet = toSet(input.blockedChapterKeys);
        const unverifiedSet = toSet(input.unverifiedPublishedKeys);
        const pendingTaskCount = Math.max(0, Math.floor(input.pendingTaskCount ?? 0));
        const missingExecutableKeys = [];
        const blockedPresentKeys = [];
        for (const key of input.knownCanonicalKeys) {
            if (publishedSet.has(key) && !unverifiedSet.has(key))
                continue;
            if (blockedSet.has(key)) {
                blockedPresentKeys.push(key);
            }
            else {
                missingExecutableKeys.push(key);
            }
        }
        const extraBlocked = [...blockedSet].filter((k) => !blockedPresentKeys.includes(k));
        const allBlocked = [...blockedPresentKeys, ...extraBlocked];
        let status;
        if (missingExecutableKeys.length === 0 &&
            allBlocked.length === 0 &&
            unverifiedSet.size === 0 &&
            pendingTaskCount === 0) {
            status = 'COMPLETED_KNOWN_COVERAGE';
        }
        else if (missingExecutableKeys.length === 0 && allBlocked.length > 0 && pendingTaskCount === 0) {
            status = 'PARTIAL_WITH_BLOCKED_GAPS';
        }
        else {
            status = 'IN_PROGRESS';
        }
        return {
            workId: input.workId,
            status,
            completed: status === 'COMPLETED_KNOWN_COVERAGE',
            keepInP0Monitoring: true,
            knownChapterCount: input.knownCanonicalKeys.length,
            publishedVerifiedCount: publishedSet.size,
            missingExecutableKeys,
            blockedChapterKeys: allBlocked,
            unverifiedPublishedKeys: [...unverifiedSet],
            pendingTaskCount,
        };
    }
}
