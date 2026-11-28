/**
 * Project Nox Importer Supremo V3.0 — P2 Quality-First Onboarding Pipeline
 *
 * Orchestrates safe batch creation (<= 10 works) ONLY when P1 gate permits
 * (or via explicit audited STAFF bypass), with durable checkpoints, Nox cover storage,
 * manual provenance / Third-AI coordination safety, immediate enrollment in P1 + P0,
 * and automatic re-pausing of normal P2 (PAUSED_P1_BUSY).
 */
import { type StoredMediaResult } from '../storage/media.js';
import type { StorageProvider } from '../storage/provider.js';
import { P2MetadataConsolidator, type ExistingCatalogWork, type P2AliasSourceEvidence, type P2MainSourceEvidence, type P2WorkQualityReport } from './p2-metadata-consolidator.js';
import type { P1CohortAndP2GateController, StaffOnboardingAuth } from './p1-cohort-manager.js';
import type { P0UniversalScanner } from './p0-universal-scanner.js';
export type P2CheckpointStatus = 'DISCOVERING' | 'CONSOLIDATING' | 'QUALITY_GATE' | 'PENDING_IDENTITY_REVIEW' | 'PENDING_METADATA_RETRY' | 'COMMITTED' | 'MERGED_EXISTING' | 'FAILED';
export interface P2OnboardingCheckpoint {
    candidateKey: string;
    workId: string | null;
    status: P2CheckpointStatus;
    storedCoverMedia?: StoredMediaResult | null;
    report?: P2WorkQualityReport;
    updatedAt: string;
}
export interface P2OnboardingPersistence {
    loadCheckpoint(candidateKey: string): Promise<P2OnboardingCheckpoint | null>;
    saveCheckpoint(cp: P2OnboardingCheckpoint): Promise<void>;
    listCatalogWorks(): Promise<ExistingCatalogWork[]>;
    insertCoverMediaRow(media: StoredMediaResult): Promise<string>;
    commitNewWorkWithCoordination(input: {
        candidateKey: string;
        title: string;
        slug: string;
        synopsis: string | null;
        coverMediaId: string;
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
    }): Promise<{
        workId: string;
        enrolledP1: boolean;
        enrolledP0: boolean;
    }>;
    enrichExistingWorkSafe(input: {
        workId: string;
        incomingTitle?: string | null;
        incomingTitleLanguage?: 'pt-BR' | 'intl' | null;
        incomingTitleTier?: 1 | 2 | 3 | 4 | null;
        incomingAliases: string[];
        incomingSynopsis: string | null;
        incomingSynopsisScore: number;
        incomingCoverMediaId: string | null;
        incomingCoverScore: number;
        incomingCoverHasPtBrTitle?: boolean;
        incomingCoverTier?: 1 | 2 | 3 | 4;
        incomingCoverVerificationMethod?: string;
        incomingMappings: Array<{
            source: string;
            sourceWorkId: string;
            sourceTitle?: string;
        }>;
        provenance: Record<string, any>;
    }): Promise<{
        updatedFields: string[];
        preservedManualFields: string[];
        skippedLockBusy: boolean;
    }>;
}
export declare class InMemoryP2OnboardingPersistence implements P2OnboardingPersistence {
    readonly checkpoints: Map<string, P2OnboardingCheckpoint>;
    readonly works: Map<string, ExistingCatalogWork & {
        coverMediaId?: string | null;
        genres?: string[];
        status?: string;
        enrolledP1?: boolean;
        enrolledP0?: boolean;
    }>;
    readonly mediaRows: Map<string, StoredMediaResult & {
        id: string;
    }>;
    private readonly busyLocks;
    setWorkBusyLock(workId: string, busy: boolean): void;
    loadCheckpoint(candidateKey: string): Promise<P2OnboardingCheckpoint | null>;
    saveCheckpoint(cp: P2OnboardingCheckpoint): Promise<void>;
    listCatalogWorks(): Promise<ExistingCatalogWork[]>;
    insertCoverMediaRow(media: StoredMediaResult): Promise<string>;
    commitNewWorkWithCoordination(input: {
        candidateKey: string;
        title: string;
        slug: string;
        synopsis: string | null;
        coverMediaId: string;
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
    }): Promise<{
        workId: string;
        enrolledP1: boolean;
        enrolledP0: boolean;
    }>;
    enrichExistingWorkSafe(input: {
        workId: string;
        incomingTitle?: string | null;
        incomingTitleLanguage?: 'pt-BR' | 'intl' | null;
        incomingTitleTier?: 1 | 2 | 3 | 4 | null;
        incomingAliases: string[];
        incomingSynopsis: string | null;
        incomingSynopsisScore: number;
        incomingCoverMediaId: string | null;
        incomingCoverScore: number;
        incomingCoverHasPtBrTitle?: boolean;
        incomingCoverTier?: 1 | 2 | 3 | 4;
        incomingCoverVerificationMethod?: string;
        incomingMappings: Array<{
            source: string;
            sourceWorkId: string;
            sourceTitle?: string;
        }>;
        provenance: Record<string, any>;
    }): Promise<{
        updatedFields: string[];
        preservedManualFields: string[];
        skippedLockBusy: boolean;
    }>;
}
export interface P2BatchCandidateInput {
    candidateKey: string;
    mainSources: readonly P2MainSourceEvidence[];
    aliasSources: readonly P2AliasSourceEvidence[];
    initialPendingChapters?: number;
    demandSignals?: {
        views24h: number;
        views7d: number;
        views30d: number;
        uniqueReaders24h?: number;
    };
}
export interface P2BatchExecutionResult {
    admitted: boolean;
    gateStateAfter: string;
    createdWorkIds: string[];
    mergedWorkIds: string[];
    pendingReviewKeys: string[];
    pendingMetadataKeys: string[];
    reports: P2WorkQualityReport[];
    reason: string;
}
export declare class P2OnboardingPipeline {
    private readonly consolidator;
    private readonly persistence;
    private readonly storage;
    private readonly gateController;
    private readonly p0Scanner?;
    constructor(consolidator: P2MetadataConsolidator, persistence: P2OnboardingPersistence, storage: StorageProvider, gateController: P1CohortAndP2GateController, p0Scanner?: P0UniversalScanner | undefined);
    runControlledBatch(candidates: readonly P2BatchCandidateInput[], options?: {
        staffBypassAuth?: StaffOnboardingAuth;
        simulateCrashAfterStage?: 'BEFORE_COMMIT';
    }): Promise<P2BatchExecutionResult>;
}
