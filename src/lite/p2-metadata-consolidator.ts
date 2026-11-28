/**
 * Project Nox Importer Supremo V3.0 — P2 Quality-First Metadata & Identity Consolidator
 *
 * Cross-evaluates the 43 main sources (all metadata/covers/synopses/titles) and the
 * 3 ALIAS_ONLY sources (mangaball, mangadex, mangafire — strictly aliases & cross-links).
 * Produces an auditable P2WorkQualityReport, enforces anti-duplication against existing
 * catalog works, selects legitimate PT-BR titles without machine-invented translations,
 * scores real downloaded cover bytes + legitimate PT-BR cover lettering without sacrificing
 * visual excellence, validates synopses against error/placeholder/truncation artifacts,
 * and respects Third AI historical recovery coordination & manual provenance locks.
 */

import { ALIAS_ONLY_SOURCE_IDS, type AliasSourceCandidate } from '../alias-sources/types.js';
import { cleanAlternativeTitle, alternativeTitleKey } from '../core/alternative-titles.js';
import { inspectCoverForPtBrTitle, type CoverInspectionResult } from '../core/cover-vision-inspector.js';
import {
  evaluateMetadataMatchEvidence,
  hasSequelOrEditionConflict,
  normalizeTitle,
} from '../core/matching.js';
import {
  isConsecratedProperTitle,
  isPortugueseWord,
  isPtBrTitle,
} from '../core/ptbr-title-localization.js';
import { isPersistableAliasScript, isPortugueseAlias } from '../alias-sources/identity-verifier.js';
import { inspectImage, type ImageInfo } from '../storage/media.js';

export const P2_MAX_SYNTHETIC_BYPASS_SOURCES = new Set<string>(ALIAS_ONLY_SOURCE_IDS);

export interface P2MainSourceEvidence {
  sourceId: string;
  sourceWorkId: string;
  status: 'OK' | 'NOT_FOUND' | 'UNAVAILABLE' | 'INVALID_DATA' | 'BLOCKED' | 'NOT_CONSULTED';
  title?: string | null;
  ptBrTitle?: string | null;
  alternativeTitles?: string[];
  synopsis?: string | null;
  coverUrl?: string | null;
  coverBytes?: Uint8Array | null;
  coverHasPtBrTextHint?: boolean;
  author?: string | null;
  artist?: string | null;
  genres?: string[];
  workStatus?: string | null;
  year?: number | null;
  externalIds?: {
    mangadexId?: string;
    anilistId?: string;
    malId?: string;
  };
  errorDetail?: string;
}

export interface P2AliasSourceEvidence {
  sourceId: string; // should belong to ALIAS_ONLY_SOURCE_IDS
  status: 'OK' | 'UNAVAILABLE' | 'NOT_FOUND' | 'INVALID_DATA' | 'NOT_CONSULTED';
  candidate?: Partial<AliasSourceCandidate> & {
    aliases?: Array<{ title: string; language?: string }>;
    externalIds?: { mangadexId?: string; anilistId?: string; malId?: string };
    // Defense-in-depth: if mistakenly present, consolidator strips & flags
    coverUrl?: unknown;
    synopsis?: unknown;
    chapters?: unknown;
  };
  errorDetail?: string;
}

export interface ExistingCatalogWork {
  id: string;
  title: string;
  slug: string;
  aliases?: string[];
  author?: string | null;
  artist?: string | null;
  synopsis?: string | null;
  year?: number | null;
  mappings?: Array<{ source: string; sourceWorkId: string }>;
  externalIds?: {
    mangadexId?: string;
    anilistId?: string;
    malId?: string;
  };
  metadataProvenance?: Record<string, any> | null;
}

export interface SelectedCoverCandidate {
  source: string;
  coverUrl: string | null;
  bytes: Uint8Array;
  info: ImageInfo;
  visualScore: number;
  hasPtBrTitle: boolean;
  ptBrCoverConfidence: number;
  ocrResult?: CoverInspectionResult;
}

export interface ConsolidatedAliasEntry {
  alias: string;
  normalizedKey: string;
  language: string;
  sources: string[];
}

export interface P2WorkQualityReport {
  candidateKey: string;
  totalMainSourcesExpected: number;
  mainSourcesChecked: string[];
  mainSourcesRespondedValid: string[];
  mainSourcesFailedOrBlocked: Array<{ sourceId: string; status: string; detail?: string }>;
  mainSourcesNotFound: string[];
  mainSourcesNotConsulted: string[];
  aliasSourcesChecked: string[];
  aliasSourcesValid: string[];
  aliasSourcesFailed: Array<{ sourceId: string; status: string; detail?: string }>;
  aliasLeakageBlocked: string[];
  identityDecision: 'CONFIRMED_NEW_WORK' | 'MATCHED_EXISTING_WORK' | 'AMBIGUOUS_PENDING_REVIEW';
  matchedWorkId: string | null;
  identityConfidence: number;
  identityReasons: string[];
  selectedTitle: {
    title: string;
    language: 'pt-BR' | 'intl';
    source: string;
    qualityScore: number;
    corroboratedBy: string[];
  } | null;
  selectedCover: {
    source: string;
    coverUrl: string | null;
    mime: string;
    width: number;
    height: number;
    byteLength: number;
    visualScore: number;
    hasPtBrTitle: boolean;
  } | null;
  selectedSynopsis: {
    text: string;
    language: 'pt-BR' | 'pt' | 'other';
    source: string;
    qualityScore: number;
  } | null;
  confirmedAliases: ConsolidatedAliasEntry[];
  pendingIssues: string[];
  gateApproved: boolean;
}

export interface P2ConsolidationResult {
  report: P2WorkQualityReport;
  coverBufferToStore?: Uint8Array;
  consolidatedPayload?: {
    title: string;
    slug: string;
    synopsis: string | null;
    aliases: string[];
    author: string | null;
    artist: string | null;
    genres: string[];
    status: string;
    provenance: Record<string, any>;
    mappings: Array<{ source: string; sourceWorkId: string; sourceTitle?: string }>;
  };
}

const SYNOPSIS_GARBAGE_REGEX =
  /erro\s+ao\s+carregar|failed\s+to\s+load|error\s+loading|loading\s*\.\.\.|carregando|sinopse\s+(?:indispon[íi]vel|em\s+breve|n[aã]o\s+encontrada|não\s+informada)|descri[çc][aã]o\s+em\s+breve|no\s+description\s+available|just\s+a\s+moment|attention\s+required|cloudflare|access\s+denied|403\s+forbidden|enable\s+javascript|page\s+not\s+found|lorem\s+ipsum/i;

const GENERIC_TITLE_PLACEHOLDERS = new Set([
  'unknown', 'untitled', 'sem titulo', 'sem título', 'loading', 'just a moment',
  'attention required', 'error', 'erro', '404', 'not found', 'n a', 'none', 'null',
]);

export function isValidTitleCandidate(raw?: string | null): boolean {
  if (!raw) return false;
  const cleaned = cleanAlternativeTitle(raw);
  if (!cleaned || cleaned.length < 2) return false;
  const folded = cleaned.toLowerCase().trim();
  if (GENERIC_TITLE_PLACEHOLDERS.has(folded)) return false;
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+){2,}$/i.test(cleaned) && !/\s/.test(cleaned)) {
    // Reject obvious unformatted machine slugs when proper titles exist elsewhere
    return false;
  }
  return true;
}

export function validateSynopsisCandidate(
  raw?: string | null,
  candidateTitle?: string | null,
): { valid: boolean; cleaned: string; language: 'pt-BR' | 'pt' | 'other'; score: number; reason?: string } {
  if (!raw || typeof raw !== 'string') {
    return { valid: false, cleaned: '', language: 'other', score: 0, reason: 'EMPTY' };
  }
  const cleaned = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 30) {
    return { valid: false, cleaned, language: 'other', score: 0, reason: 'TOO_SHORT_OR_TRUNCATED' };
  }
  if (SYNOPSIS_GARBAGE_REGEX.test(cleaned)) {
    return { valid: false, cleaned, language: 'other', score: 0, reason: 'ERROR_OR_PLACEHOLDER_TEXT' };
  }
  if (/\.{3}$|…$/.test(cleaned) && cleaned.length < 90) {
    return { valid: false, cleaned, language: 'other', score: 0, reason: 'TRUNCATED_ELLIPSIS' };
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  let ptHits = 0;
  for (const w of words) {
    if (isPortugueseWord(w)) ptHits += 1;
  }
  const ptRatio = words.length > 0 ? ptHits / words.length : 0;
  const hasPtDiacritics = /[ãõçáéíóúâêôàü]/i.test(cleaned);
  const language: 'pt-BR' | 'pt' | 'other' =
    ptHits >= 3 && (hasPtDiacritics || ptRatio >= 0.16)
      ? 'pt-BR'
      : ptHits >= 2 && ptRatio >= 0.1
        ? 'pt'
        : 'other';

  let score = Math.min(40, Math.round(cleaned.length / 8));
  if (language === 'pt-BR') score += 50;
  else if (language === 'pt') score += 32;
  else score += 10;

  if (candidateTitle && cleaned.toLowerCase().includes(candidateTitle.toLowerCase().slice(0, 12))) {
    score += 5;
  }

  return { valid: true, cleaned, language, score };
}

export function scoreCoverVisualQuality(info: ImageInfo, byteLength: number): number {
  if (!info.width || !info.height || byteLength < 1500) return 0;
  const area = info.width * info.height;
  const resolutionScore = Math.min(45, Math.round((area / 900_000) * 45));
  const ratio = info.width / info.height;
  // Vertical comic cover portrait ratio typically ~0.62 - 0.80
  const aspectScore =
    ratio >= 0.52 && ratio <= 0.85 ? 25 : ratio >= 0.45 && ratio <= 1.05 ? 12 : 2;
  const bpp = byteLength / area;
  const sharpnessScore = bpp >= 0.15 ? 20 : bpp >= 0.08 ? 14 : bpp >= 0.04 ? 8 : 3;
  const minDimensionScore = info.width >= 400 && info.height >= 560 ? 10 : info.width >= 260 ? 5 : 0;
  return Math.min(100, resolutionScore + aspectScore + sharpnessScore + minDimensionScore);
}

export function detectAliasLanguage(title: string, explicitLang?: string): string {
  if (explicitLang && explicitLang !== 'und' && explicitLang !== 'unknown') {
    return explicitLang.toLowerCase();
  }
  if (/[\uac00-\ud7af]/.test(title)) return 'ko';
  if (/[\u3040-\u30ff]/.test(title)) return 'ja';
  if (/[\u4e00-\u9fff]/.test(title)) return 'zh';
  if (isPortugueseAlias(title)) return 'pt-BR';
  return 'en';
}

export function safeSlugify(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || `work-${Date.now()}`;
}

export class P2MetadataConsolidator {
  constructor(private readonly options: {
    allowForeignSynopsisFallback?: boolean;
    requireSynopsisForApproval?: boolean;
    runOcrOnCovers?: boolean;
    expectedMainSourceCount?: number;
  } = {}) {}

  async consolidate(input: {
    candidateKey: string;
    mainSources: readonly P2MainSourceEvidence[];
    aliasSources: readonly P2AliasSourceEvidence[];
    existingCatalog: readonly ExistingCatalogWork[];
  }): Promise<P2ConsolidationResult> {
    const aliasLeakageBlocked: string[] = [];
    const usableMain: P2MainSourceEvidence[] = [];
    const mainSourcesChecked: string[] = [];
    const mainSourcesRespondedValid: string[] = [];
    const mainSourcesFailedOrBlocked: Array<{ sourceId: string; status: string; detail?: string }> = [];
    const mainSourcesNotFound: string[] = [];
    const mainSourcesNotConsulted: string[] = [];

    for (const s of input.mainSources) {
      if (P2_MAX_SYNTHETIC_BYPASS_SOURCES.has(s.sourceId)) {
        aliasLeakageBlocked.push(s.sourceId);
        continue;
      }
      mainSourcesChecked.push(s.sourceId);
      if (s.status === 'OK') {
        usableMain.push(s);
        mainSourcesRespondedValid.push(s.sourceId);
      } else if (s.status === 'NOT_FOUND') {
        mainSourcesNotFound.push(s.sourceId);
      } else if (s.status === 'NOT_CONSULTED') {
        mainSourcesNotConsulted.push(s.sourceId);
      } else {
        mainSourcesFailedOrBlocked.push({ sourceId: s.sourceId, status: s.status, detail: s.errorDetail });
      }
    }

    const aliasSourcesChecked: string[] = [];
    const aliasSourcesValid: string[] = [];
    const aliasSourcesFailed: Array<{ sourceId: string; status: string; detail?: string }> = [];
    const validatedAliasPayloads: P2AliasSourceEvidence[] = [];

    for (const a of input.aliasSources) {
      aliasSourcesChecked.push(a.sourceId);
      if (a.status === 'OK' && a.candidate) {
        if (a.candidate.coverUrl || a.candidate.synopsis || a.candidate.chapters) {
          aliasLeakageBlocked.push(`${a.sourceId}:stripped_media_fields`);
        }
        // Strictly allow ONLY aliases + external cross-links + primaryTitle alias
        validatedAliasPayloads.push({
          ...a,
          candidate: {
            sourceWorkId: a.candidate.sourceWorkId,
            primaryTitle: a.candidate.primaryTitle,
            aliases: a.candidate.aliases,
            externalIds: a.candidate.externalIds,
          },
        });
        aliasSourcesValid.push(a.sourceId);
      } else {
        aliasSourcesFailed.push({ sourceId: a.sourceId, status: a.status, detail: a.errorDetail });
      }
    }

    // 1. Gather titles & creators across valid main sources + alias sources (strictly aliases)
    const gatheredTitles: Array<{ title: string; source: string; isExplicitPt: boolean }> = [];
    const allAuthors: string[] = [];
    const allArtists: string[] = [];
    const allGenres = new Set<string>();
    const combinedExternalIds: { mangadexId?: string; anilistId?: string; malId?: string } = {};
    const sourceMappings: Array<{ source: string; sourceWorkId: string; sourceTitle?: string }> = [];
    let bestStatus = 'UNKNOWN';

    for (const m of usableMain) {
      if (m.sourceWorkId) {
        sourceMappings.push({ source: m.sourceId, sourceWorkId: m.sourceWorkId, sourceTitle: m.title || undefined });
      }
      if (m.ptBrTitle && isValidTitleCandidate(m.ptBrTitle)) {
        const cleanPt = cleanAlternativeTitle(m.ptBrTitle);
        if (cleanPt) gatheredTitles.push({ title: cleanPt, source: m.sourceId, isExplicitPt: true });
      }
      if (m.title && isValidTitleCandidate(m.title)) {
        const cleanT = cleanAlternativeTitle(m.title);
        if (cleanT) gatheredTitles.push({ title: cleanT, source: m.sourceId, isExplicitPt: false });
      }
      for (const alt of m.alternativeTitles ?? []) {
        if (isValidTitleCandidate(alt)) {
          const cleanAlt = cleanAlternativeTitle(alt);
          if (cleanAlt) gatheredTitles.push({ title: cleanAlt, source: m.sourceId, isExplicitPt: false });
        }
      }
      if (m.author?.trim()) allAuthors.push(m.author.trim());
      if (m.artist?.trim()) allArtists.push(m.artist.trim());
      for (const g of m.genres ?? []) {
        if (g.trim()) allGenres.add(g.trim());
      }
      if (bestStatus === 'UNKNOWN' && m.workStatus && m.workStatus !== 'UNKNOWN') {
        bestStatus = m.workStatus;
      }
      if (m.externalIds?.mangadexId && !combinedExternalIds.mangadexId) combinedExternalIds.mangadexId = m.externalIds.mangadexId;
      if (m.externalIds?.anilistId && !combinedExternalIds.anilistId) combinedExternalIds.anilistId = m.externalIds.anilistId;
      if (m.externalIds?.malId && !combinedExternalIds.malId) combinedExternalIds.malId = m.externalIds.malId;
    }

    // 2. Consolidate Aliases (43 Main + 3 ALIAS_ONLY)
    const aliasBuckets = new Map<string, ConsolidatedAliasEntry>();
    const addAlias = (rawTitle: string, sourceId: string, explicitLang?: string) => {
      const cleaned = cleanAlternativeTitle(rawTitle);
      if (!cleaned || !isPersistableAliasScript(cleaned)) return;
      const key = alternativeTitleKey(cleaned);
      if (!key) return;
      const lang = detectAliasLanguage(cleaned, explicitLang);
      const existing = aliasBuckets.get(key);
      if (existing) {
        if (!existing.sources.includes(sourceId)) existing.sources.push(sourceId);
        if (existing.language === 'en' && lang !== 'en') existing.language = lang;
      } else {
        aliasBuckets.set(key, { alias: cleaned, normalizedKey: key, language: lang, sources: [sourceId] });
      }
    };

    for (const t of gatheredTitles) addAlias(t.title, t.source, t.isExplicitPt ? 'pt-BR' : undefined);
    for (const a of validatedAliasPayloads) {
      if (a.candidate?.primaryTitle) addAlias(a.candidate.primaryTitle, a.sourceId);
      for (const al of a.candidate?.aliases ?? []) {
        addAlias(al.title, a.sourceId, al.language);
      }
      if (a.candidate?.externalIds?.mangadexId && !combinedExternalIds.mangadexId) {
        combinedExternalIds.mangadexId = a.candidate.externalIds.mangadexId;
      }
      if (a.candidate?.externalIds?.anilistId && !combinedExternalIds.anilistId) {
        combinedExternalIds.anilistId = a.candidate.externalIds.anilistId;
      }
      if (a.candidate?.externalIds?.malId && !combinedExternalIds.malId) {
        combinedExternalIds.malId = a.candidate.externalIds.malId;
      }
    }

    // 3. Select Best Proven Title (PT-BR priority without invented translations)
    const titleScoreMap = new Map<string, {
      display: string;
      isPtBr: boolean;
      sources: Set<string>;
      score: number;
    }>();

    for (const t of gatheredTitles) {
      const key = alternativeTitleKey(t.title);
      if (!key) continue;
      const pt = t.isExplicitPt || isPtBrTitle(t.title) || isPortugueseAlias(t.title);
      const consecrated = isConsecratedProperTitle(t.title);
      let entry = titleScoreMap.get(key);
      if (!entry) {
        entry = { display: t.title, isPtBr: pt, sources: new Set([t.source]), score: 0 };
        titleScoreMap.set(key, entry);
      } else {
        entry.sources.add(t.source);
        if (pt) entry.isPtBr = true;
      }
      // Prefer PT-BR proven across main sources, or consecrated franchise names
      entry.score =
        (entry.isPtBr ? 60 : consecrated ? 45 : 20) +
        Math.min(30, entry.sources.size * 12) +
        (t.title.length >= 6 && t.title.length <= 90 ? 10 : 0);
    }

    const rankedTitles = [...titleScoreMap.values()].sort(
      (a, b) => b.score - a.score || b.sources.size - a.sources.size || a.display.length - b.display.length,
    );
    const chosenTitleEntry = rankedTitles[0] ?? null;

    const selectedTitle = chosenTitleEntry
      ? {
          title: chosenTitleEntry.display,
          language: (chosenTitleEntry.isPtBr ? 'pt-BR' : 'intl') as 'pt-BR' | 'intl',
          source: [...chosenTitleEntry.sources][0],
          qualityScore: chosenTitleEntry.score,
          corroboratedBy: [...chosenTitleEntry.sources],
        }
      : null;

    // 4. Select Best Synopsis (PT-BR -> PT -> Other -> null with pending issue)
    const validSynopses: Array<{
      text: string;
      language: 'pt-BR' | 'pt' | 'other';
      source: string;
      qualityScore: number;
    }> = [];
    for (const m of usableMain) {
      const check = validateSynopsisCandidate(m.synopsis, selectedTitle?.title);
      if (!check.valid) continue;
      if (check.language === 'other' && this.options.allowForeignSynopsisFallback === false) continue;
      validSynopses.push({
        text: check.cleaned,
        language: check.language,
        source: m.sourceId,
        qualityScore: check.score,
      });
    }
    validSynopses.sort((a, b) => b.qualityScore - a.qualityScore);
    const selectedSynopsis = validSynopses[0] ?? null;

    // 5. Intelligent Cover Selection (43 main sources only)
    const validCovers: SelectedCoverCandidate[] = [];
    for (const m of usableMain) {
      if (!m.coverBytes || m.coverBytes.byteLength < 1500) continue;
      try {
        const info = inspectImage(m.coverBytes);
        const visualScore = scoreCoverVisualQuality(info, m.coverBytes.byteLength);
        if (visualScore === 0) continue;

        let hasPtBrTitle = Boolean(m.coverHasPtBrTextHint);
        let ptBrCoverConfidence = hasPtBrTitle ? 0.85 : 0;
        let ocrResult: CoverInspectionResult | undefined;

        if (!hasPtBrTitle && this.options.runOcrOnCovers && selectedTitle) {
          ocrResult = await inspectCoverForPtBrTitle({
            title: selectedTitle.title,
            aliases: [...aliasBuckets.values()].map((a) => a.alias),
            coverBuffer: Buffer.from(m.coverBytes),
            source: m.sourceId,
          });
          if (ocrResult.foundPtBrTitle) {
            hasPtBrTitle = true;
            ptBrCoverConfidence = ocrResult.confidence;
          }
        }

        validCovers.push({
          source: m.sourceId,
          coverUrl: m.coverUrl ?? null,
          bytes: m.coverBytes,
          info,
          visualScore,
          hasPtBrTitle,
          ptBrCoverConfidence,
          ocrResult,
        });
      } catch {
        // Broken/corrupt image rejected strictly (HTML-200 or invalid header)
      }
    }

    let chosenCover: SelectedCoverCandidate | null = null;
    if (validCovers.length > 0) {
      const sortedByQuality = [...validCovers].sort((a, b) => b.visualScore - a.visualScore);
      const topQuality = sortedByQuality[0];
      const ptBrComparable = sortedByQuality.find(
        (c) => c.hasPtBrTitle && c.visualScore >= 45 && topQuality.visualScore - c.visualScore <= 18,
      );
      chosenCover = ptBrComparable ?? topQuality;
    }

    // 6. Identity Verification Against Existing Catalog (Anti-Duplication)
    const candidateAliases = [...aliasBuckets.values()].map((a) => a.alias);
    const primaryTitle = selectedTitle?.title || '';
    const candidateSynopsis = selectedSynopsis?.text;
    const candidateAuthor = allAuthors[0] || undefined;
    const candidateArtist = allArtists[0] || undefined;

    let identityDecision: P2WorkQualityReport['identityDecision'] = 'CONFIRMED_NEW_WORK';
    let matchedWorkId: string | null = null;
    let identityConfidence = usableMain.length > 0 ? Math.min(1, 0.55 + usableMain.length * 0.1) : 0;
    const identityReasons: string[] = [];

    for (const existing of input.existingCatalog) {
      // Strong signal 1: confirmed source mapping
      if (
        existing.mappings?.some((em) =>
          sourceMappings.some((sm) => sm.source === em.source && sm.sourceWorkId === em.sourceWorkId),
        )
      ) {
        identityDecision = 'MATCHED_EXISTING_WORK';
        matchedWorkId = existing.id;
        identityConfidence = 1;
        identityReasons.push('CONFIRMED_SOURCE_MAPPING_MATCH');
        break;
      }

      // Strong signal 2: shared MangaDex / AniList / MAL ID
      if (
        (combinedExternalIds.mangadexId && existing.externalIds?.mangadexId === combinedExternalIds.mangadexId) ||
        (combinedExternalIds.anilistId && existing.externalIds?.anilistId === combinedExternalIds.anilistId) ||
        (combinedExternalIds.malId && existing.externalIds?.malId === combinedExternalIds.malId)
      ) {
        identityDecision = 'MATCHED_EXISTING_WORK';
        matchedWorkId = existing.id;
        identityConfidence = 0.99;
        identityReasons.push('EXTERNAL_ID_MATCH');
        break;
      }

      // Multi-signal title + alias + creator + synopsis comparison
      const candTitlesFolded = new Set(
        [primaryTitle, ...candidateAliases].map(normalizeTitle).filter(Boolean),
      );
      const existTitlesFolded = new Set(
        [existing.title, ...(existing.aliases || [])].map(normalizeTitle).filter(Boolean),
      );
      const exactTitleOrAliasOverlap = [...candTitlesFolded].some((t) => existTitlesFolded.has(t));

      const ev = evaluateMetadataMatchEvidence(
        {
          title: primaryTitle,
          aliases: candidateAliases,
          author: candidateAuthor,
          artist: candidateArtist,
          synopsis: candidateSynopsis,
        },
        {
          title: existing.title,
          aliases: existing.aliases,
          author: existing.author || undefined,
          artist: existing.artist || undefined,
          synopsis: existing.synopsis || undefined,
          year: existing.year,
        },
      );

      const sequelConflict = hasSequelOrEditionConflict(primaryTitle, existing.title);
      const creatorMismatch =
        Boolean(candidateAuthor && existing.author) &&
        normalizeTitle(candidateAuthor || '') !== normalizeTitle(existing.author || '');

      if (exactTitleOrAliasOverlap && !sequelConflict && !creatorMismatch) {
        identityDecision = 'MATCHED_EXISTING_WORK';
        matchedWorkId = existing.id;
        identityConfidence = Math.max(0.92, ev.score);
        identityReasons.push('CROSS_LANGUAGE_ALIAS_OR_TITLE_MATCH');
        break;
      }

      if (!sequelConflict && ev.autoMatch && !creatorMismatch) {
        identityDecision = 'MATCHED_EXISTING_WORK';
        matchedWorkId = existing.id;
        identityConfidence = ev.score;
        identityReasons.push('METADATA_MULTI_SIGNAL_MATCH');
        break;
      }

      if (!sequelConflict && (ev.ambiguous || ev.titleSimilarity >= 0.72)) {
        identityDecision = 'AMBIGUOUS_PENDING_REVIEW';
        matchedWorkId = existing.id;
        identityConfidence = ev.score;
        identityReasons.push(
          creatorMismatch
            ? 'SIMILAR_TITLE_CONFLICTING_CREATORS_HELD_FOR_REVIEW'
            : 'BORDERLINE_SIMILARITY_HELD_FOR_REVIEW',
        );
        break;
      }
    }

    // 7. Pending issues & Quality Gate decision
    const pendingIssues: string[] = [];
    if (!selectedTitle) pendingIssues.push('MISSING_VALID_TITLE');
    if (!chosenCover) pendingIssues.push('MISSING_VALID_COVER');
    if (!selectedSynopsis) pendingIssues.push('MISSING_RELIABLE_SYNOPSIS');
    if (mainSourcesFailedOrBlocked.length > 0) pendingIssues.push('SOME_MAIN_SOURCES_FAILED_OR_BLOCKED');
    if (mainSourcesNotConsulted.length > 0) pendingIssues.push('PARTIAL_MAIN_SOURCE_COVERAGE');
    if (identityDecision === 'AMBIGUOUS_PENDING_REVIEW') pendingIssues.push('AMBIGUOUS_IDENTITY_REVIEW_REQUIRED');
    if (aliasLeakageBlocked.length > 0) pendingIssues.push('ALIAS_ONLY_CONTENT_BLOCKED');

    const synopsisGateOk = this.options.requireSynopsisForApproval ? Boolean(selectedSynopsis) : true;
    const gateApproved =
      Boolean(selectedTitle) &&
      Boolean(chosenCover) &&
      synopsisGateOk &&
      identityDecision === 'CONFIRMED_NEW_WORK' &&
      usableMain.length > 0;

    const nowIso = new Date().toISOString();
    const report: P2WorkQualityReport = {
      candidateKey: input.candidateKey,
      totalMainSourcesExpected: this.options.expectedMainSourceCount ?? 43,
      mainSourcesChecked,
      mainSourcesRespondedValid,
      mainSourcesFailedOrBlocked,
      mainSourcesNotFound,
      mainSourcesNotConsulted,
      aliasSourcesChecked,
      aliasSourcesValid,
      aliasSourcesFailed,
      aliasLeakageBlocked,
      identityDecision,
      matchedWorkId,
      identityConfidence: Number(identityConfidence.toFixed(3)),
      identityReasons,
      selectedTitle,
      selectedCover: chosenCover
        ? {
            source: chosenCover.source,
            coverUrl: chosenCover.coverUrl,
            mime: chosenCover.info.mime,
            width: chosenCover.info.width,
            height: chosenCover.info.height,
            byteLength: chosenCover.bytes.byteLength,
            visualScore: chosenCover.visualScore,
            hasPtBrTitle: chosenCover.hasPtBrTitle,
          }
        : null,
      selectedSynopsis,
      confirmedAliases: [...aliasBuckets.values()],
      pendingIssues,
      gateApproved,
    };

    const consolidatedPayload = selectedTitle
      ? {
          title: selectedTitle.title,
          slug: safeSlugify(selectedTitle.title),
          synopsis: selectedSynopsis ? selectedSynopsis.text : null,
          aliases: candidateAliases,
          author: candidateAuthor ?? null,
          artist: candidateArtist ?? null,
          genres: [...allGenres],
          status: bestStatus,
          provenance: {
            title: {
              source: selectedTitle.source,
              language: selectedTitle.language,
              quality_score: selectedTitle.qualityScore,
              localized_ptbr: selectedTitle.language === 'pt-BR',
              corroborated_by: selectedTitle.corroboratedBy,
              updated_at: nowIso,
              owner: 'importer-p2-v3',
            },
            ...(chosenCover
              ? {
                  cover: {
                    source: chosenCover.source,
                    quality_score: chosenCover.visualScore,
                    has_ptbr_title: chosenCover.hasPtBrTitle,
                    updated_at: nowIso,
                    owner: 'importer-p2-v3',
                  },
                }
              : {}),
            ...(selectedSynopsis
              ? {
                  synopsis: {
                    source: selectedSynopsis.source,
                    language: selectedSynopsis.language,
                    quality_score: selectedSynopsis.qualityScore,
                    updated_at: nowIso,
                    owner: 'importer-p2-v3',
                  },
                }
              : {}),
            aliases: {
              sources: [...new Set([...mainSourcesRespondedValid, ...aliasSourcesValid])],
              count: candidateAliases.length,
              updated_at: nowIso,
              owner: 'importer-p2-v3',
            },
          },
          mappings: sourceMappings,
        }
      : undefined;

    return {
      report,
      coverBufferToStore: chosenCover?.bytes,
      consolidatedPayload,
    };
  }
}
