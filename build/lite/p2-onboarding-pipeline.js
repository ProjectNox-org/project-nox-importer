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
import { processAndStoreMedia } from '../storage/media.js';
export class InMemoryP2OnboardingPersistence {
    checkpoints = new Map();
    works = new Map();
    mediaRows = new Map();
    busyLocks = new Set();
    setWorkBusyLock(workId, busy) {
        if (busy)
            this.busyLocks.add(workId);
        else
            this.busyLocks.delete(workId);
    }
    async loadCheckpoint(candidateKey) {
        const cp = this.checkpoints.get(candidateKey);
        return cp ? structuredClone(cp) : null;
    }
    async saveCheckpoint(cp) {
        this.checkpoints.set(cp.candidateKey, structuredClone(cp));
    }
    async listCatalogWorks() {
        return [...this.works.values()];
    }
    async insertCoverMediaRow(media) {
        const incomingSha = media.mediaRecord?.sha256;
        const existing = incomingSha
            ? [...this.mediaRows.values()].find((m) => m.mediaRecord?.sha256 === incomingSha)
            : undefined;
        if (existing)
            return existing.id;
        const id = media.mediaId || crypto.randomUUID();
        this.mediaRows.set(id, { ...media, mediaId: id, id });
        return id;
    }
    async commitNewWorkWithCoordination(input) {
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
    async enrichExistingWorkSafe(input) {
        if (this.busyLocks.has(input.workId)) {
            return { updatedFields: [], preservedManualFields: [], skippedLockBusy: true };
        }
        const work = this.works.get(input.workId);
        if (!work)
            return { updatedFields: [], preservedManualFields: [], skippedLockBusy: false };
        const prov = { ...(work.metadataProvenance || {}) };
        const updatedFields = [];
        const preservedManualFields = [];
        if (prov.title?.source === 'manual')
            preservedManualFields.push('title');
        if (prov.slug?.source === 'manual')
            preservedManualFields.push('slug');
        // Additive alias union preserving all pre-existing aliases
        const mergedAliases = computeMergedWorkAliases({
            id: work.id,
            title: work.title,
            slug: work.slug,
            aliases: work.aliases || [],
            author: work.author || null,
            artist: work.artist || null,
        }, input.incomingAliases.map((title) => ({ title }))).aliasesAfter;
        if (mergedAliases.length !== (work.aliases || []).length) {
            work.aliases = mergedAliases;
            updatedFields.push('aliases');
        }
        // Monotonicity + manual lock on synopsis
        if (prov.synopsis?.source === 'manual') {
            preservedManualFields.push('synopsis');
        }
        else if (input.incomingSynopsis &&
            input.incomingSynopsisScore > Number(prov.synopsis?.quality_score ?? 0)) {
            work.synopsis = input.incomingSynopsis;
            prov.synopsis = input.provenance.synopsis;
            updatedFields.push('synopsis');
        }
        // Monotonicity + manual lock on cover
        if (prov.cover?.source === 'manual') {
            preservedManualFields.push('cover');
        }
        else if (input.incomingCoverMediaId &&
            input.incomingCoverScore > Number(prov.cover?.quality_score ?? 0)) {
            work.coverMediaId = input.incomingCoverMediaId;
            prov.cover = input.provenance.cover;
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
export class P2OnboardingPipeline {
    consolidator;
    persistence;
    storage;
    gateController;
    p0Scanner;
    constructor(consolidator, persistence, storage, gateController, p0Scanner) {
        this.consolidator = consolidator;
        this.persistence = persistence;
        this.storage = storage;
        this.gateController = gateController;
        this.p0Scanner = p0Scanner;
    }
    async runControlledBatch(candidates, options = {}) {
        if (!options.staffBypassAuth) {
            const snap = this.gateController.reconcile();
            if (snap.p2GateState === 'PAUSED_P1_BUSY') {
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
        }
        const batch = candidates.slice(0, 10);
        const createdWorkIds = [];
        const mergedWorkIds = [];
        const pendingReviewKeys = [];
        const pendingMetadataKeys = [];
        const reports = [];
        const worksToEnrollInP1 = [];
        for (const cand of batch) {
            const existingCp = await this.persistence.loadCheckpoint(cand.candidateKey);
            if (existingCp?.status === 'COMMITTED' && existingCp.workId) {
                createdWorkIds.push(existingCp.workId);
                if (existingCp.report)
                    reports.push(existingCp.report);
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
                            .filter((t) => Boolean(t && t.trim())),
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
                let coverId = null;
                if (consolidated.coverBufferToStore && consolidated.report.selectedCover) {
                    const stored = existingCp?.storedCoverMedia
                        ?? (await processAndStoreMedia({}, this.storage, consolidated.coverBufferToStore, 'importer-p2-v3', 'editorial', undefined, { skipDbInsert: true, skipDedupLookup: true }));
                    coverId = await this.persistence.insertCoverMediaRow(stored);
                }
                await this.persistence.enrichExistingWorkSafe({
                    workId: consolidated.report.matchedWorkId,
                    incomingAliases: consolidated.consolidatedPayload?.aliases || [],
                    incomingSynopsis: consolidated.report.selectedSynopsis?.text || null,
                    incomingSynopsisScore: consolidated.report.selectedSynopsis?.qualityScore ?? 0,
                    incomingCoverMediaId: coverId,
                    incomingCoverScore: consolidated.report.selectedCover?.visualScore ?? 0,
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
                ?? (await processAndStoreMedia({}, this.storage, consolidated.coverBufferToStore, 'importer-p2-v3', 'editorial', undefined, { skipDbInsert: true, skipDedupLookup: true }));
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
            });
            if (this.p0Scanner) {
                const p0Work = {
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
            }
            else {
                const admission = this.gateController.tryAdmitNormalP2Batch(worksToEnrollInP1, 10);
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
