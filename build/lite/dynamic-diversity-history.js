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
export const DIVERSITY_HISTORY_SETTINGS_KEY = 'importer_v3_diversity_history_v1';
const NOISE_TWO_CHAR_TOKENS = new Set([
    'eu', 'ei', 'ne', 'de', 'da', 'do', 'em', 'um', 'na', 'no', 'os', 'as', 'se', 'ou',
    'by', 'of', 'in', 'on', 'at', 'to', 'an', 'is', 'it', 'ok', 'hi', 'no', 'xx', '--',
]);
const VALID_SHORT_TAXONOMY_TOKENS = new Set([
    'bl', 'gl', 'hq', '3d', 'ia', 'ai', 'sf', '4k', '18',
]);
const PLACEHOLDER_OR_STATUS_NOISE = new Set([
    'n/a', 'n-a', 'na', 'none', 'null', 'undefined', 'unknown', 'desconhecido',
    'generico', 'generic', 'sem-genero', 'sem-tag', 'sem-tags', 'no-genre',
    'outro', 'outros', 'other', 'others', 'misc', 'miscellaneous', 'tbd', 'todo',
    'test', 'teste', 'error', 'loading', 'undefined-tag', 'placeholder',
    'ongoing', 'completed', 'complete', 'hiatus', 'dropped', 'cancelled', 'canceled',
    'em-andamento', 'concluido', 'completo', 'finalizado', 'cancelado', 'pausado',
    'manga', 'manhwa', 'manhua', 'webtoon', 'comic', 'comics', 'novel', 'light-novel',
    'one-shot', 'oneshot', 'raw', 'scan',
]);
/**
 * Dynamically normalizes any candidate genre/tag without a fixed allowlist.
 * Returns canonical lowercase hyphenated slug, or null if empty/noise/invalid.
 */
export function normalizeDynamicTaxonomyTag(raw) {
    if (typeof raw !== 'string')
        return null;
    const trimmed = raw.normalize('NFKC').trim();
    if (!trimmed || trimmed.length > 48)
        return null;
    // Reject HTML/script/CSS/URL fragments and non-taxonomy garbage
    if (/[<>={}[\]\\]|https?:\/\/|www\.|script|javascript:|cubic-bezier|rgb\(/i.test(trimmed)) {
        return null;
    }
    // Reject excessively long prose sentences masquerading as tags
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (wordCount >= 6)
        return null;
    const asciiFolded = trimmed
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    const slug = asciiFolded
        .replace(/[^a-z0-9+\s_-]+/g, ' ')
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (!slug || slug.length < 2 || slug.length > 48)
        return null;
    if (/^\d+$/.test(slug))
        return null;
    if (PLACEHOLDER_OR_STATUS_NOISE.has(slug))
        return null;
    if (slug.length === 2) {
        if (NOISE_TWO_CHAR_TOKENS.has(slug) || !VALID_SHORT_TAXONOMY_TOKENS.has(slug)) {
            return null;
        }
    }
    return slug;
}
/**
 * Normalizes and deduplicates ALL legitimate tags for a work without truncating at 5.
 */
export function normalizeDynamicTaxonomyTags(rawTags) {
    if (!rawTags || rawTags.length === 0)
        return [];
    const seen = new Set();
    const out = [];
    for (const item of rawTags) {
        const norm = normalizeDynamicTaxonomyTag(item);
        if (!norm || seen.has(norm))
            continue;
        seen.add(norm);
        out.push(norm);
    }
    return out;
}
export class DiversitySelectionHistory {
    maxEntries;
    decayFactor;
    records = [];
    versionCounter = 0;
    constructor(options = {}) {
        this.maxEntries = Math.max(10, Math.min(300, Math.floor(options.maxEntries ?? 120)));
        this.decayFactor = Math.max(0.8, Math.min(0.99, options.decayFactor ?? 0.96));
        if (options.initialRecords?.length) {
            for (const rec of options.initialRecords.slice(-this.maxEntries)) {
                const cleanGenres = normalizeDynamicTaxonomyTags(rec.genres);
                this.records.push({
                    workId: String(rec.workId || ''),
                    selectedAtMs: Number.isFinite(rec.selectedAtMs) ? rec.selectedAtMs : Date.now(),
                    source: rec.source ? String(rec.source).trim().toLowerCase() : null,
                    kind: rec.kind ? String(rec.kind).trim().toUpperCase() : null,
                    contentRating: rec.contentRating ? String(rec.contentRating).trim().toUpperCase() : null,
                    popularityTier: rec.popularityTier ? String(rec.popularityTier).trim().toUpperCase() : null,
                    genres: cleanGenres,
                });
            }
        }
    }
    getEntryCount() {
        return this.records.length;
    }
    getVersion() {
        return this.versionCounter;
    }
    recordSelection(record) {
        const cleanWorkId = String(record.workId || '').trim();
        if (!cleanWorkId)
            return;
        // Idempotency across container restarts: never double-count a work still in the most recent active window.
        const recentTail = this.records.slice(-15);
        if (recentTail.some((r) => r.workId === cleanWorkId)) {
            return;
        }
        const cleanGenres = normalizeDynamicTaxonomyTags(record.genres);
        this.records.push({
            workId: cleanWorkId,
            selectedAtMs: Number.isFinite(record.selectedAtMs) ? record.selectedAtMs : Date.now(),
            source: record.source ? String(record.source).trim().toLowerCase() : null,
            kind: record.kind ? String(record.kind).trim().toUpperCase() : null,
            contentRating: record.contentRating ? String(record.contentRating).trim().toUpperCase() : null,
            popularityTier: record.popularityTier ? String(record.popularityTier).trim().toUpperCase() : null,
            genres: cleanGenres,
        });
        if (this.records.length > this.maxEntries) {
            this.records.splice(0, this.records.length - this.maxEntries);
        }
        this.versionCounter++;
    }
    recordCohortAdmissions(entries) {
        const before = this.versionCounter;
        for (const entry of entries) {
            this.recordSelection(entry);
        }
        return this.versionCounter - before;
    }
    getDecayedProfile() {
        const genres = {};
        const sources = {};
        const kinds = {};
        const contentRatings = {};
        const popularityTiers = {};
        let totalWeight = 0;
        const n = this.records.length;
        for (let i = 0; i < n; i++) {
            const age = n - 1 - i;
            const w = Math.pow(this.decayFactor, age);
            totalWeight += w;
            const rec = this.records[i];
            if (rec.source)
                sources[rec.source] = (sources[rec.source] ?? 0) + w;
            if (rec.kind)
                kinds[rec.kind] = (kinds[rec.kind] ?? 0) + w;
            if (rec.contentRating)
                contentRatings[rec.contentRating] = (contentRatings[rec.contentRating] ?? 0) + w;
            if (rec.popularityTier)
                popularityTiers[rec.popularityTier] = (popularityTiers[rec.popularityTier] ?? 0) + w;
            // Distribute genre weight across all normalized tags with sublinear dampening per work
            // so works with 12 tags enrich every tag without letting multi-tag works dominate total share.
            const gLen = rec.genres.length;
            if (gLen > 0) {
                const perTagWeight = w / Math.sqrt(gLen);
                for (const g of rec.genres) {
                    genres[g] = (genres[g] ?? 0) + perTagWeight;
                }
            }
        }
        return {
            totalWeight,
            distinctKnownGenres: Math.max(4, Object.keys(genres).length),
            distinctKnownSources: Math.max(5, Object.keys(sources).length),
            distinctKnownKinds: Math.max(3, Object.keys(kinds).length),
            distinctKnownRatings: Math.max(2, Object.keys(contentRatings).length),
            distinctKnownPopularities: Math.max(3, Object.keys(popularityTiers).length),
            genres,
            sources,
            kinds,
            contentRatings,
            popularityTiers,
        };
    }
    /**
     * Scores both current-cohort uniqueness and accumulated cross-cohort novelty/de-concentration
     * across ALL valid tags (dynamic, zero fixed list). Never rejects any candidate cleanly.
     */
    computeCrossCohortAdjustment(candidate, currentMix = {}, profile = this.getDecayedProfile()) {
        const normalizedGenres = candidate.preNormalized && Array.isArray(candidate.genres)
            ? candidate.genres
            : normalizeDynamicTaxonomyTags(candidate.genres);
        if (profile.totalWeight <= 0) {
            return {
                totalBonus: 0,
                normalizedGenres,
                unseenHistoricalGenreCount: normalizedGenres.length,
                rareHistoricalGenreCount: normalizedGenres.length,
            };
        }
        const total = profile.totalWeight;
        let genreDelta = 0;
        let unseenHistoricalGenreCount = 0;
        let rareHistoricalGenreCount = 0;
        if (normalizedGenres.length > 0) {
            const expectedShare = 1 / profile.distinctKnownGenres;
            let noveltySum = 0;
            let saturationPenalty = 0;
            for (let i = 0; i < normalizedGenres.length; i++) {
                const g = normalizedGenres[i];
                const histWeight = profile.genres[g] ?? 0;
                const share = histWeight / total;
                const currentInCohort = currentMix.genreCounts?.get(g) ?? 0;
                if (histWeight === 0) {
                    unseenHistoricalGenreCount++;
                    // Brand-new or unseen dynamic genre gets strong novelty boost even beyond tag #5
                    noveltySum += currentInCohort === 0 ? 16 : 6;
                }
                else if (share < expectedShare * 0.65) {
                    rareHistoricalGenreCount++;
                    noveltySum += 9 * (1 - Math.min(1, share / Math.max(0.01, expectedShare)));
                }
                else if (share > expectedShare * 1.8) {
                    const excess = Math.min(1.5, (share - expectedShare * 1.8) / Math.max(0.05, expectedShare));
                    saturationPenalty += 7.5 * excess;
                }
            }
            // Sublinear aggregation evaluates ALL N tags fairly without giving a 20-tag work 20x raw additive bias
            const boundedNovelty = unseenHistoricalGenreCount > 0 || rareHistoricalGenreCount > 0
                ? Math.min(34, (noveltySum / Math.sqrt(Math.max(1, normalizedGenres.length))) * 1.65 + (unseenHistoricalGenreCount > 0 ? 6 : 0))
                : 0;
            const boundedPenalty = Math.min(18, saturationPenalty / Math.max(1, normalizedGenres.length * 0.6));
            genreDelta = boundedNovelty - boundedPenalty;
        }
        let facetDelta = 0;
        const scoreFacet = (val, histMap, distinctCount, maxNovelty, maxPenalty) => {
            if (!val)
                return 0;
            const hist = histMap[val] ?? 0;
            const expected = 1 / distinctCount;
            const share = hist / total;
            if (hist === 0)
                return maxNovelty;
            if (share < expected * 0.6)
                return maxNovelty * 0.65;
            if (share > expected * 1.65) {
                return -Math.min(maxPenalty, maxPenalty * ((share - expected * 1.65) / Math.max(0.08, expected)));
            }
            return 0;
        };
        const normSource = candidate.source ? String(candidate.source).trim().toLowerCase() : null;
        const normKind = candidate.kind ? String(candidate.kind).trim().toUpperCase() : null;
        const normRating = candidate.contentRating ? String(candidate.contentRating).trim().toUpperCase() : null;
        const normPop = candidate.popularityTier ? String(candidate.popularityTier).trim().toUpperCase() : null;
        facetDelta += scoreFacet(normSource, profile.sources, profile.distinctKnownSources, 16, 12);
        facetDelta += scoreFacet(normKind, profile.kinds, profile.distinctKnownKinds, 14, 10);
        facetDelta += scoreFacet(normRating, profile.contentRatings, profile.distinctKnownRatings, 14, 9);
        facetDelta += scoreFacet(normPop, profile.popularityTiers, profile.distinctKnownPopularities, 8, 5);
        return {
            totalBonus: Number((genreDelta + facetDelta).toFixed(4)),
            normalizedGenres,
            unseenHistoricalGenreCount,
            rareHistoricalGenreCount,
        };
    }
    getSnapshot() {
        const distinctGenres = new Set();
        const distinctSources = new Set();
        for (const r of this.records) {
            if (r.source)
                distinctSources.add(r.source);
            for (const g of r.genres)
                distinctGenres.add(g);
        }
        return {
            version: 1,
            maxEntries: this.maxEntries,
            entryCount: this.records.length,
            distinctHistoricalGenres: distinctGenres.size,
            distinctHistoricalSources: distinctSources.size,
            records: this.records.map((r) => ({ ...r, genres: [...r.genres] })),
        };
    }
    serialize() {
        return JSON.stringify(this.getSnapshot());
    }
    static deserialize(raw, options = {}) {
        if (!raw || typeof raw !== 'string') {
            return new DiversitySelectionHistory(options);
        }
        try {
            const parsed = JSON.parse(raw);
            const records = Array.isArray(parsed?.records) ? parsed.records : [];
            return new DiversitySelectionHistory({
                ...options,
                initialRecords: records,
            });
        }
        catch {
            return new DiversitySelectionHistory(options);
        }
    }
}
