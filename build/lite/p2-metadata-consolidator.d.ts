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
import { type AliasSourceCandidate } from '../alias-sources/types.js';
import { type CoverInspectionResult } from '../core/cover-vision-inspector.js';
import { type TitlePriorityTier } from '../core/ptbr-title-localization.js';
import { type ImageInfo } from '../storage/media.js';
export declare const P2_MAX_SYNTHETIC_BYPASS_SOURCES: Set<string>;
/**
 * Audited Brazilian PT-BR sources whose visually adequate covers are eligible
 * for Tier 2 (legitimate BR source cover) when no OCR/verified PT-BR cover is available.
 */
export declare const BRAZILIAN_TRUSTED_SOURCES: Set<string>;
export type CoverPriorityTier = 1 | 2 | 3 | 4;
export type CoverVerificationMethod = 'ocr_verified' | 'verified_hint' | 'trusted_br_source' | 'none';
export declare function isVisuallyAdequatePtBrCover(info: ImageInfo, visualScore: number): boolean;
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
    coverPtBrVerified?: boolean;
    isBrazilianSource?: boolean;
    coverVerificationMethod?: CoverVerificationMethod;
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
    sourceId: string;
    status: 'OK' | 'UNAVAILABLE' | 'NOT_FOUND' | 'INVALID_DATA' | 'NOT_CONSULTED';
    candidate?: Partial<AliasSourceCandidate> & {
        aliases?: Array<{
            title: string;
            language?: string;
        }>;
        externalIds?: {
            mangadexId?: string;
            anilistId?: string;
            malId?: string;
        };
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
    mappings?: Array<{
        source: string;
        sourceWorkId: string;
    }>;
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
    coverTier: CoverPriorityTier;
    hasPtBrTitle: boolean;
    isBrazilianSource: boolean;
    visuallyAdequate: boolean;
    verificationMethod: CoverVerificationMethod;
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
    mainSourcesFailedOrBlocked: Array<{
        sourceId: string;
        status: string;
        detail?: string;
    }>;
    mainSourcesNotFound: string[];
    mainSourcesNotConsulted: string[];
    aliasSourcesChecked: string[];
    aliasSourcesValid: string[];
    aliasSourcesFailed: Array<{
        sourceId: string;
        status: string;
        detail?: string;
    }>;
    aliasLeakageBlocked: string[];
    identityDecision: 'CONFIRMED_NEW_WORK' | 'MATCHED_EXISTING_WORK' | 'AMBIGUOUS_PENDING_REVIEW';
    matchedWorkId: string | null;
    identityConfidence: number;
    identityReasons: string[];
    selectedTitle: {
        title: string;
        language: 'pt-BR' | 'intl';
        titleTier: TitlePriorityTier;
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
        coverTier: CoverPriorityTier;
        hasPtBrTitle: boolean;
        verificationMethod: CoverVerificationMethod;
        ptBrConfidence: number;
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
        mappings: Array<{
            source: string;
            sourceWorkId: string;
            sourceTitle?: string;
        }>;
    };
}
export declare function isValidTitleCandidate(raw?: string | null): boolean;
export declare function validateSynopsisCandidate(raw?: string | null, candidateTitle?: string | null): {
    valid: boolean;
    cleaned: string;
    language: 'pt-BR' | 'pt' | 'other';
    score: number;
    reason?: string;
};
export declare function scoreCoverVisualQuality(info: ImageInfo, byteLength: number): number;
export declare function detectAliasLanguage(title: string, explicitLang?: string): string;
export declare function safeSlugify(title: string): string;
export declare class P2MetadataConsolidator {
    private readonly options;
    constructor(options?: {
        allowForeignSynopsisFallback?: boolean;
        requireSynopsisForApproval?: boolean;
        runOcrOnCovers?: boolean;
        expectedMainSourceCount?: number;
    });
    consolidate(input: {
        candidateKey: string;
        mainSources: readonly P2MainSourceEvidence[];
        aliasSources: readonly P2AliasSourceEvidence[];
        existingCatalog: readonly ExistingCatalogWork[];
    }): Promise<P2ConsolidationResult>;
}
