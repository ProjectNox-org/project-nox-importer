/**
 * Project Nox Importer Supremo V3.0 — P2 Quality-First Onboarding Pipeline
 *
 * Orchestrates safe batch creation (<= 10 works) ONLY when P1 gate permits
 * (or via explicit audited STAFF bypass), with durable checkpoints, Nox cover storage,
 * manual provenance / Third-AI coordination safety, immediate enrollment in P1 + P0,
 * and automatic re-pausing of normal P2 (PAUSED_P1_BUSY).
 */

import crypto from 'node:crypto';
import { computeMergedWorkAliases } from '../alias-sources/identity-verifier.js';
import { isProtectedEditorialProvenance, isPtBrTitle } from '../core/ptbr-title-localization.js';
import { processAndStoreMedia, type StoredMediaResult } from '../storage/media.js';
import type { StorageProvider } from '../storage/provider.js';
import {
  P2MetadataConsolidator,
  type ExistingCatalogWork,
  type P2AliasSourceEvidence,
  type P2MainSourceEvidence,
  type P2WorkQualityReport,
} from './p2-metadata-consolidator.js';
import { classifyPopularityTier } from './demand-scorer.js';
import type { P1CohortAndP2GateController, P1WorkState, StaffOnboardingAuth } from './p1-cohort-manager.js';
import type { CanonicalP0Work, P0UniversalScanner } from './p0-universal-scanner.js';

export type P2CheckpointStatus =
  | 'DISCOVERING'
  | 'CONSOLIDATING'
  | 'QUALITY_GATE'
  | 'PENDING_IDENTITY_REVIEW'
  | 'PENDING_METADATA_RETRY'
  | 'COMMITTED'
  | 'MERGED_EXISTING'
  | 'FAILED';

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
    mappings: Array<{ source: string; sourceWorkId: string; sourceTitle?: string }>;
  }): Promise<{ workId: string; enrolledP1: boolean; enrolledP0: boolean }>;
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
    incomingMappings: Array<{ source: string; sourceWorkId: string; sourceTitle?: string }>;
    provenance: Record<string, any>;
  }): Promise<{ updatedFields: string[]; preservedManualFields: string[]; skippedLockBusy: boolean }>;
}

export class InMemoryP2OnboardingPersistence implements P2OnboardingPersistence {
  readonly checkpoints = new Map<string, P2OnboardingCheckpoint>();
  readonly works = new Map<string, ExistingCatalogWork & {
    coverMediaId?: string | null;
    genres?: string[];
    status?: string;
    enrolledP1?: boolean;
    enrolledP0?: boolean;
  }>();
  readonly mediaRows = new Map<string, StoredMediaResult & { id: string }>();
  private readonly busyLocks = new Set<string>();

  setWorkBusyLock(workId: string, busy: boolean): void {
    if (busy) this.busyLocks.add(workId);
    else this.busyLocks.delete(workId);
  }

  async loadCheckpoint(candidateKey: string): Promise<P2OnboardingCheckpoint | null> {
    const cp = this.checkpoints.get(candidateKey);
    return cp ? structuredClone(cp) : null;
  }

  async saveCheckpoint(cp: P2OnboardingCheckpoint): Promise<void> {
    this.checkpoints.set(cp.candidateKey, structuredClone(cp));
  }

  async listCatalogWorks(): Promise<ExistingCatalogWork[]> {
    return [...this.works.values()];
  }

  async insertCoverMediaRow(media: StoredMediaResult): Promise<string> {
    const incomingSha = media.mediaRecord?.sha256;
    const existing = incomingSha
      ? [...this.mediaRows.values()].find((m) => m.mediaRecord?.sha256 === incomingSha)
      : undefined;
    if (existing) return existing.id;
    const id = media.mediaId || crypto.randomUUID();
    this.mediaRows.set(id, { ...media, mediaId: id, id });
    return id;
  }

  async commitNewWorkWithCoordination(input: {
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
    mappings: Array<{ source: string; sourceWorkId: string; sourceTitle?: string }>;
  }): Promise<{ workId: string; enrolledP1: boolean; enrolledP0: boolean }> {
    // Idempotency by committed checkpoint or identical slug/mapping
    const cp = this.checkpoints.get(input.candidateKey);
    if (cp?.status === 'COMMITTED' && cp.workId && this.works.has(cp.workId)) {
      return { workId: cp.workId, enrolledP1: true, enrolledP0: true };
    }
    const existingBySlug = [...this.works.values()].find((w) => w.slug === input.slug);
    if (existingBySlug) {
      return { workId: existingBySlug.id, enrolledP1: Boolean(existingBySlug.enrolledP1), enrolledP0: Boolean(existingBySlug.enrolledP0) };
    }
    const workId = crypto.randomUUID();
    this.works.set(workId, {
      id: workId,
      title: input.title,
      slug: input.slug,
      synopsis: input.synopsis,
      coverMediaId: input.coverMediaId,
      aliases: [...input.aliases],
      author: input.author,
      artist: input.artist,
      genres: [...input.genres],
      status: input.status,
      mappings: input.mappings.map((m) => ({ source: m.source, sourceWorkId: m.sourceWorkId })),
      metadataProvenance: structuredClone(input.provenance),
      enrolledP1: true,
      enrolledP0: true,
    });
    return { workId, enrolledP1: true, enrolledP0: true };
  }

  async enrichExistingWorkSafe(input: {
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
    incomingMappings: Array<{ source: string; sourceWorkId: string; sourceTitle?: string }>;
    provenance: Record<string, any>;
  }): Promise<{ updatedFields: string[]; preservedManualFields: string[]; skippedLockBusy: boolean }> {
    if (this.busyLocks.has(input.workId)) {
      return { updatedFields: [], preservedManualFields: [], skippedLockBusy: true };
    }
    const work = this.works.get(input.workId);
    if (!work) return { updatedFields: [], preservedManualFields: [], skippedLockBusy: false };

    const prov = { ...(work.metadataProvenance || {}) };
    const updatedFields: string[] = [];
    const preservedManualFields: string[] = [];

    const titleProtected =
      isProtectedEditorialProvenance(prov.title) ||
      prov.title?.localized_ptbr === true ||
      isPtBrTitle(work.title);
    if (isProtectedEditorialProvenance(prov.title)) preservedManualFields.push('title');
    if (isProtectedEditorialProvenance(prov.slug)) preservedManualFields.push('slug');

    let nextTitle = work.title;
    if (
      !titleProtected &&
      input.incomingTitle &&
      (input.incomingTitleLanguage === 'pt-BR' || (input.incomingTitleTier !== undefined && input.incomingTitleTier !== null && input.incomingTitleTier <= 2))
    ) {
      const previousTitle = work.title;
      nextTitle = input.incomingTitle;
      work.title = nextTitle;
      prov.title = {
        ...(input.provenance.title || {}),
        localized_ptbr: true,
        previous_value: previousTitle,
      };
      updatedFields.push('title');
    }

    // Additive alias union preserving all pre-existing aliases + previous title if upgraded
    const aliasSeed = [
      ...input.incomingAliases,
      ...(nextTitle !== work.title ? [work.title] : []),
      ...(updatedFields.includes('title') && prov.title?.previous_value ? [String(prov.title.previous_value)] : []),
    ];
    const mergedAliases = computeMergedWorkAliases(
      {
        id: work.id,
        title: work.title,
        slug: work.slug,
        aliases: work.aliases || [],
        author: work.author || null,
        artist: work.artist || null,
      },
      aliasSeed.map((title) => ({ title })),
    ).aliasesAfter;

    if (mergedAliases.length !== (work.aliases || []).length) {
      work.aliases = mergedAliases;
      updatedFields.push('aliases');
    }

    // Monotonicity + manual / Third-AI lock on synopsis
    if (isProtectedEditorialProvenance(prov.synopsis)) {
      preservedManualFields.push('synopsis');
    } else if (
      input.incomingSynopsis &&
      input.incomingSynopsisScore > Number(prov.synopsis?.quality_score ?? 0)
    ) {
      work.synopsis = input.incomingSynopsis;
      prov.synopsis = input.provenance.synopsis;
      updatedFields.push('synopsis');
    }

    // Cover Precedence: manual/third-AI immutable; valid PT-BR cover NEVER downgraded to foreign
    const existingCoverIsPtBr = prov.cover?.has_ptbr_title === true || prov.cover?.cover_tier === 1;
    const incomingCoverIsPtBr = Boolean(input.incomingCoverHasPtBrTitle) || input.incomingCoverTier === 1;
    const existingCoverTier: number = Number(prov.cover?.cover_tier ?? (existingCoverIsPtBr ? 1 : 4));
    const incomingCoverTier: number = Number(input.incomingCoverTier ?? (incomingCoverIsPtBr ? 1 : 4));

    if (isProtectedEditorialProvenance(prov.cover)) {
      preservedManualFields.push('cover');
    } else if (existingCoverIsPtBr && !incomingCoverIsPtBr) {
      preservedManualFields.push('cover');
    } else if (
      input.incomingCoverMediaId &&
      (!work.coverMediaId ||
        incomingCoverTier < existingCoverTier ||
        (incomingCoverTier === existingCoverTier && input.incomingCoverScore > Number(prov.cover?.quality_score ?? 0)))
    ) {
      const previousCoverId = work.coverMediaId ?? null;
      work.coverMediaId = input.incomingCoverMediaId;
      prov.cover = {
        ...(input.provenance.cover || {}),
        ...(previousCoverId ? { previous_cover_id: previousCoverId } : {}),
        has_ptbr_title: incomingCoverIsPtBr,
        cover_tier: incomingCoverTier,
        verification_method: input.incomingCoverVerificationMethod || input.provenance.cover?.verification_method || 'none',
      };
      updatedFields.push('cover');
    }

    // Additive verified source mappings
    const existingMappings = work.mappings || [];
    for (const m of input.incomingMappings) {
      if (!existingMappings.some((em) => em.source === m.source && em.sourceWorkId === m.sourceWorkId)) {
        existingMappings.push({ source: m.source, sourceWorkId: m.sourceWorkId });
      }
    }
    work.mappings = existingMappings;
    work.metadataProvenance = prov;
    return { updatedFields, preservedManualFields, skippedLockBusy: false };
  }
}

export interface P2BatchCandidateInput {
  candidateKey: string;
  mainSources: readonly P2MainSourceEvidence[];
  aliasSources: readonly P2AliasSourceEvidence[];
  initialPendingChapters?: number;
  kind?: string | null;
  contentRating?: string | null;
  genres?: readonly string[];
  primarySource?: string | null;
  demandSignals?: {
    views24h: number;
    views7d: number;
    views30d: number;
    uniqueReaders24h?: number;
  };
}

export function selectDiverseP2Candidates(
  candidates: readonly P2BatchCandidateInput[],
  limit: number,
  options: {
    existingFocusMix?: {
      sources?: Record<string, number>;
      genres?: Record<string, number>;
      kinds?: Record<string, number>;
      contentRatings?: Record<string, number>;
    };
    randomFn?: () => number;
  } = {},
): P2BatchCandidateInput[] {
  const targetCount = Math.max(0, Math.floor(limit));
  if (targetCount === 0 || candidates.length === 0) return [];
  const randomFn = options.randomFn ?? Math.random;
  const sourceCounts = new Map<string, number>(Object.entries(options.existingFocusMix?.sources || {}));
  const genreCounts = new Map<string, number>(Object.entries(options.existingFocusMix?.genres || {}));
  const kindCounts = new Map<string, number>(Object.entries(options.existingFocusMix?.kinds || {}));
  const ratingCounts = new Map<string, number>(Object.entries(options.existingFocusMix?.contentRatings || {}));
  const popCounts = new Map<string, number>();

  const bump = (map: Map<string, number>, key?: string | null) => {
    const k = String(key || '').trim().toLowerCase();
    if (k) map.set(k, (map.get(k) ?? 0) + 1);
  };
  const inferSource = (c: P2BatchCandidateInput) =>
    c.primarySource || c.mainSources.find((m) => m.status === 'OK')?.sourceId || 'unknown';
  const inferGenres = (c: P2BatchCandidateInput) =>
    c.genres && c.genres.length > 0 ? c.genres : (c.mainSources.find((m) => m.genres?.length)?.genres || []);

  const pool = candidates.map((cand) => ({ cand, jitter: randomFn() * 14 }));
  const chosen: P2BatchCandidateInput[] = [];

  while (chosen.length < targetCount && pool.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const { cand, jitter } = pool[i];
      const src = inferSource(cand).toLowerCase();
      const genres = inferGenres(cand).map((g) => g.toLowerCase());
      const kind = String(cand.kind || 'MANHWA').toLowerCase();
      const rating = String(cand.contentRating || 'GENERAL').toLowerCase();
      const pop = classifyPopularityTier(cand.demandSignals?.views7d ?? 50, cand.demandSignals?.views30d ?? 100);

      let score = jitter;
      const srcCount = sourceCounts.get(src) ?? 0;
      score += srcCount === 0 ? 28 : srcCount === 1 ? 10 : -srcCount * 5;
      if (genres.some((g) => (genreCounts.get(g) ?? 0) === 0)) score += 20;
      const kCount = kindCounts.get(kind) ?? 0;
      score += kCount === 0 ? 18 : 0;
      const rCount = ratingCounts.get(rating) ?? 0;
      score += rCount === 0 ? 18 : 0;
      score += (popCounts.get(pop) ?? 0) === 0 ? 12 : 0;

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    const picked = pool.splice(bestIdx, 1)[0].cand;
    chosen.push(picked);
    bump(sourceCounts, inferSource(picked));
    for (const g of inferGenres(picked)) bump(genreCounts, g);
    bump(kindCounts, picked.kind || 'MANHWA');
    bump(ratingCounts, picked.contentRating || 'GENERAL');
    bump(popCounts, classifyPopularityTier(picked.demandSignals?.views7d ?? 50, picked.demandSignals?.views30d ?? 100));
  }

  return chosen;
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

export class P2OnboardingPipeline {
  constructor(
    private readonly consolidator: P2MetadataConsolidator,
    private readonly persistence: P2OnboardingPersistence,
    private readonly storage: StorageProvider,
    private readonly gateController: P1CohortAndP2GateController,
    private readonly p0Scanner?: P0UniversalScanner,
  ) {}

  async runControlledBatch(
    candidates: readonly P2BatchCandidateInput[],
    options: {
      staffBypassAuth?: StaffOnboardingAuth;
      simulateCrashAfterStage?: 'BEFORE_COMMIT';
      allowDeficitReplenishment?: boolean;
      diversifySelection?: boolean;
      randomFn?: () => number;
      maxBatchSize?: number;
    } = {},
  ): Promise<P2BatchExecutionResult> {
    let effectiveCap = Math.min(10, Math.max(1, options.maxBatchSize ?? 10));
    if (!options.staffBypassAuth) {
      const snap = this.gateController.reconcile();
      const plan = this.gateController.getP2ReplenishmentPlan();
      const deficitAllowed = Boolean(options.allowDeficitReplenishment) && plan.deficit > 0;
      if (snap.p2GateState === 'PAUSED_P1_BUSY' && !deficitAllowed) {
        return {
          admitted: false,
          gateStateAfter: 'PAUSED_P1_BUSY',
          createdWorkIds: [],
          mergedWorkIds: [],
          pendingReviewKeys: [],
          pendingMetadataKeys: [],
          reports: [],
          reason: 'PAUSED_P1_BUSY: P1 has executable work; normal P2 batch blocked',
        };
      }
      if (deficitAllowed && (snap.p2GateState === 'ELIGIBLE_P1_DEFICIT' || snap.p2GateState === 'PAUSED_P1_BUSY')) {
        effectiveCap = Math.min(effectiveCap, plan.deficit);
      }
    }

    const batch = options.diversifySelection
      ? selectDiverseP2Candidates(candidates, effectiveCap, { randomFn: options.randomFn })
      : candidates.slice(0, effectiveCap);
    const createdWorkIds: string[] = [];
    const mergedWorkIds: string[] = [];
    const pendingReviewKeys: string[] = [];
    const pendingMetadataKeys: string[] = [];
    const reports: P2WorkQualityReport[] = [];
    const worksToEnrollInP1: P1WorkState[] = [];

    for (const cand of batch) {
      const existingCp = await this.persistence.loadCheckpoint(cand.candidateKey);
      if (existingCp?.status === 'COMMITTED' && existingCp.workId) {
        createdWorkIds.push(existingCp.workId);
        if (existingCp.report) reports.push(existingCp.report);
        // Crash recovery guard: ensure P1 + P0 enrollment completes even if crash occurred right after DB commit
        const pendingChapters = Math.max(1, cand.initialPendingChapters ?? 1);
        worksToEnrollInP1.push({
          workId: existingCp.workId,
          views24h: cand.demandSignals?.views24h ?? 10,
          views7d: cand.demandSignals?.views7d ?? 50,
          views30d: cand.demandSignals?.views30d ?? 100,
          uniqueReaders24h: cand.demandSignals?.uniqueReaders24h ?? 5,
          publishedChapters: 0,
          totalManifestChapters: pendingChapters,
          hasP0NewReleaseBlocked: false,
          hoursWaitingInQueue: 0,
          pendingChapters,
          executableChapters: pendingChapters,
          runningChapters: 0,
          externallyBlocked: false,
        });
        if (this.p0Scanner) {
          const fallbackTitle = cand.mainSources.find((m) => m.title?.trim())?.title?.trim() || cand.candidateKey;
          const fallbackSlug = fallbackTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || existingCp.workId;
          this.p0Scanner.enqueueImmediateWork({
            id: existingCp.workId,
            title: fallbackTitle,
            slug: fallbackSlug,
            aliases: cand.aliasSources
              .flatMap((a) => (a.candidate?.aliases || []).map((al) => al.title))
              .filter((t): t is string => Boolean(t && t.trim())),
          });
        }
        continue;
      }

      const existingCatalog = await this.persistence.listCatalogWorks();
      const consolidated = await this.consolidator.consolidate({
        candidateKey: cand.candidateKey,
        mainSources: cand.mainSources,
        aliasSources: cand.aliasSources,
        existingCatalog,
      });
      reports.push(consolidated.report);

      await this.persistence.saveCheckpoint({
        candidateKey: cand.candidateKey,
        workId: consolidated.report.matchedWorkId,
        status: 'QUALITY_GATE',
        storedCoverMedia: existingCp?.storedCoverMedia ?? null,
        report: consolidated.report,
        updatedAt: new Date().toISOString(),
      });

      if (consolidated.report.identityDecision === 'AMBIGUOUS_PENDING_REVIEW') {
        pendingReviewKeys.push(cand.candidateKey);
        await this.persistence.saveCheckpoint({
          candidateKey: cand.candidateKey,
          workId: consolidated.report.matchedWorkId,
          status: 'PENDING_IDENTITY_REVIEW',
          report: consolidated.report,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      if (consolidated.report.identityDecision === 'MATCHED_EXISTING_WORK' && consolidated.report.matchedWorkId) {
        let coverId: string | null = null;
        if (consolidated.coverBufferToStore && consolidated.report.selectedCover) {
          const stored = existingCp?.storedCoverMedia
            ?? (await processAndStoreMedia({} as any, this.storage, consolidated.coverBufferToStore, 'importer-p2-v3', 'editorial', undefined, { skipDbInsert: true, skipDedupLookup: true }));
          coverId = await this.persistence.insertCoverMediaRow(stored);
        }
        await this.persistence.enrichExistingWorkSafe({
          workId: consolidated.report.matchedWorkId,
          incomingTitle: consolidated.report.selectedTitle?.title || null,
          incomingTitleLanguage: consolidated.report.selectedTitle?.language || null,
          incomingTitleTier: consolidated.report.selectedTitle?.titleTier ?? null,
          incomingAliases: consolidated.consolidatedPayload?.aliases || [],
          incomingSynopsis: consolidated.report.selectedSynopsis?.text || null,
          incomingSynopsisScore: consolidated.report.selectedSynopsis?.qualityScore ?? 0,
          incomingCoverMediaId: coverId,
          incomingCoverScore: consolidated.report.selectedCover?.visualScore ?? 0,
          incomingCoverHasPtBrTitle: consolidated.report.selectedCover?.hasPtBrTitle ?? false,
          incomingCoverTier: consolidated.report.selectedCover?.coverTier,
          incomingCoverVerificationMethod: consolidated.report.selectedCover?.verificationMethod,
          incomingMappings: consolidated.consolidatedPayload?.mappings || [],
          provenance: consolidated.consolidatedPayload?.provenance || {},
        });
        mergedWorkIds.push(consolidated.report.matchedWorkId);
        await this.persistence.saveCheckpoint({
          candidateKey: cand.candidateKey,
          workId: consolidated.report.matchedWorkId,
          status: 'MERGED_EXISTING',
          report: consolidated.report,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      if (!consolidated.report.gateApproved || !consolidated.consolidatedPayload || !consolidated.coverBufferToStore) {
        pendingMetadataKeys.push(cand.candidateKey);
        await this.persistence.saveCheckpoint({
          candidateKey: cand.candidateKey,
          workId: null,
          status: 'PENDING_METADATA_RETRY',
          report: consolidated.report,
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      // Store cover via Project Nox storage pipeline (reuse checkpointed upload if resuming after crash!)
      const storedCover = existingCp?.storedCoverMedia
        ?? (await processAndStoreMedia({} as any, this.storage, consolidated.coverBufferToStore, 'importer-p2-v3', 'editorial', undefined, { skipDbInsert: true, skipDedupLookup: true }));

      await this.persistence.saveCheckpoint({
        candidateKey: cand.candidateKey,
        workId: null,
        status: 'CONSOLIDATING',
        storedCoverMedia: storedCover,
        report: consolidated.report,
        updatedAt: new Date().toISOString(),
      });

      if (options.simulateCrashAfterStage === 'BEFORE_COMMIT') {
        throw new Error(`SIMULATED_CRASH_BEFORE_COMMIT:${cand.candidateKey}`);
      }

      const coverMediaId = await this.persistence.insertCoverMediaRow(storedCover);
      const committed = await this.persistence.commitNewWorkWithCoordination({
        candidateKey: cand.candidateKey,
        title: consolidated.consolidatedPayload.title,
        slug: consolidated.consolidatedPayload.slug,
        synopsis: consolidated.consolidatedPayload.synopsis,
        coverMediaId,
        aliases: consolidated.consolidatedPayload.aliases,
        author: consolidated.consolidatedPayload.author,
        artist: consolidated.consolidatedPayload.artist,
        genres: consolidated.consolidatedPayload.genres,
        status: consolidated.consolidatedPayload.status,
        provenance: consolidated.consolidatedPayload.provenance,
        mappings: consolidated.consolidatedPayload.mappings,
      });

      createdWorkIds.push(committed.workId);
      await this.persistence.saveCheckpoint({
        candidateKey: cand.candidateKey,
        workId: committed.workId,
        status: 'COMMITTED',
        storedCoverMedia: storedCover,
        report: consolidated.report,
        updatedAt: new Date().toISOString(),
      });

      // Enroll immediately into P0 monitoring + P1 completion queue
      const pendingChapters = Math.max(1, cand.initialPendingChapters ?? 1);
      const enrollGenres = cand.genres && cand.genres.length > 0
        ? cand.genres
        : consolidated.consolidatedPayload.genres;
      const enrollSource = cand.primarySource
        || consolidated.consolidatedPayload.mappings[0]?.source
        || null;
      worksToEnrollInP1.push({
        workId: committed.workId,
        views24h: cand.demandSignals?.views24h ?? 10,
        views7d: cand.demandSignals?.views7d ?? 50,
        views30d: cand.demandSignals?.views30d ?? 100,
        uniqueReaders24h: cand.demandSignals?.uniqueReaders24h ?? 5,
        publishedChapters: 0,
        totalManifestChapters: pendingChapters,
        hasP0NewReleaseBlocked: false,
        hoursWaitingInQueue: 0,
        pendingChapters,
        executableChapters: pendingChapters,
        runningChapters: 0,
        externallyBlocked: false,
        kind: cand.kind ?? null,
        contentRating: cand.contentRating ?? null,
        genres: enrollGenres,
        primarySource: enrollSource,
      });

      if (this.p0Scanner) {
        const p0Work: CanonicalP0Work = {
          id: committed.workId,
          title: consolidated.consolidatedPayload.title,
          slug: consolidated.consolidatedPayload.slug,
          aliases: consolidated.consolidatedPayload.aliases,
        };
        this.p0Scanner.enqueueImmediateWork(p0Work);
      }
    }

    let gateStateAfter = this.gateController.getP2GateState();
    if (worksToEnrollInP1.length > 0) {
      if (options.staffBypassAuth) {
        for (const w of worksToEnrollInP1) {
          this.gateController.admitStaffOnboarding(options.staffBypassAuth, w);
        }
        gateStateAfter = this.gateController.reconcile().p2GateState;
      } else if (options.allowDeficitReplenishment) {
        const admission = this.gateController.tryAdmitDeficitP2Batch(worksToEnrollInP1, effectiveCap);
        gateStateAfter = admission.gateState;
      } else {
        const admission = this.gateController.tryAdmitNormalP2Batch(worksToEnrollInP1, effectiveCap);
        gateStateAfter = admission.gateState;
      }
    }

    return {
      admitted: createdWorkIds.length > 0 || mergedWorkIds.length > 0,
      gateStateAfter,
      createdWorkIds,
      mergedWorkIds,
      pendingReviewKeys,
      pendingMetadataKeys,
      reports,
      reason: options.staffBypassAuth
        ? `STAFF_ONBOARDING_COMPLETE(created=${createdWorkIds.length})`
        : `P2_BATCH_COMPLETE(created=${createdWorkIds.length}, merged=${mergedWorkIds.length}) -> ${gateStateAfter}`,
    };
  }
}
