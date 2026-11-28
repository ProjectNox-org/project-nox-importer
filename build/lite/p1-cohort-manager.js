/**
 * Project Nox Importer Supremo V3.0 — P1 Focused Cohort Manager & P2 Gate Lock
 *
 * Contracts (Parts 06, 07, 08, 37 + P2 Quality Reinforcement):
 * - Default P1 cohort size is strictly 10 works (adaptable 5..9 on measured bottleneck).
 * - Concentrates chapter imports on the active cohort until manifest completion or external block,
 *   replacing slots 1-for-1 rather than spreading 1 chapter across 100 works.
 * - Normal P2 stays atomically in PAUSED_P1_BUSY whenever ANY P1 work is executable.
 * - Normal P2 batch (<= 10) opens ONLY when P1 has zero executable work (drained or all externally blocked),
 *   without deleting pending P1 checkpoints; as soon as new P2 works enroll in P0+P1, P2 pauses again.
 * - Authenticated & auditable STAFF onboarding remains an isolated exception (priority STAFF < P0).
 */
import { selectFocusedP1Cohort } from './demand-scorer.js';
export function computeAdaptiveCohortSize(bottleneck) {
    if (!bottleneck)
        return 10;
    let size = 10;
    if ((bottleneck.rssMiB ?? 0) >= 520 || (bottleneck.pgLocksWaiting ?? 0) >= 3) {
        size = 5;
    }
    else if ((bottleneck.dbPoolWaitMs ?? 0) >= 250 || (bottleneck.apiP95RegressionPct ?? 0) > 5) {
        size = 7;
    }
    else if ((bottleneck.rssMiB ?? 0) >= 460 || (bottleneck.dbPoolWaitMs ?? 0) >= 100) {
        size = 8;
    }
    return Math.max(5, Math.min(10, size));
}
export class P1CohortAndP2GateController {
    works = new Map();
    cohortIds = [];
    targetSize = 10;
    p2GateState = 'ELIGIBLE_P1_EMPTY';
    staffAuditLog = [];
    seedWorks(initial) {
        this.works.clear();
        for (const w of initial) {
            this.works.set(w.workId, { ...w });
        }
        this.reconcile();
    }
    getTargetSize() {
        return this.targetSize;
    }
    getActiveCohortIds() {
        return [...this.cohortIds];
    }
    getP2GateState() {
        return this.p2GateState;
    }
    getPendingWork(workId) {
        return this.works.get(workId);
    }
    getStaffAuditLog() {
        return [...this.staffAuditLog];
    }
    reconcile(bottleneck) {
        this.targetSize = computeAdaptiveCohortSize(bottleneck);
        // Keep still-executable or running, non-blocked current cohort members first (slot stability),
        // evicting completed, externally blocked, or non-executable stalled works so other works don't starve.
        const retained = this.cohortIds.filter((id) => {
            const w = this.works.get(id);
            return Boolean(w &&
                w.pendingChapters > 0 &&
                !w.externallyBlocked &&
                (w.executableChapters > 0 || w.runningChapters > 0));
        });
        const retainedSet = new Set(retained);
        const eligibleBacklog = [];
        let hasAnyExecutableP1 = false;
        let hasPendingBlockedP1 = false;
        for (const w of this.works.values()) {
            if (w.pendingChapters <= 0)
                continue;
            if (w.externallyBlocked || (w.executableChapters <= 0 && w.runningChapters <= 0)) {
                hasPendingBlockedP1 = true;
                continue;
            }
            hasAnyExecutableP1 = true;
            eligibleBacklog.push({
                ...w,
                currentlyInCohort: retainedSet.has(w.workId),
            });
        }
        if (retained.length < this.targetSize) {
            const openSlots = this.targetSize - retained.length;
            const fillCandidates = eligibleBacklog.filter((c) => !retainedSet.has(c.workId));
            const { selectedIds } = selectFocusedP1Cohort(fillCandidates, Math.max(5, openSlots));
            const next = [...retained, ...selectedIds.slice(0, openSlots)];
            this.cohortIds = next.slice(0, this.targetSize);
        }
        else {
            this.cohortIds = retained.slice(0, this.targetSize);
        }
        this.p2GateState = hasAnyExecutableP1
            ? 'PAUSED_P1_BUSY'
            : hasPendingBlockedP1
                ? 'ELIGIBLE_P1_ALL_BLOCKED'
                : 'ELIGIBLE_P1_EMPTY';
        return {
            cohortIds: [...this.cohortIds],
            targetSize: this.targetSize,
            p2GateState: this.p2GateState,
        };
    }
    /** Marks next missing chapter inside focused cohort complete, opening a slot 1-for-1 when finished. */
    recordChapterCompleted(workId) {
        const w = this.works.get(workId);
        if (!w)
            return { workCompleted: false, newCohort: [...this.cohortIds] };
        w.publishedChapters += 1;
        w.pendingChapters = Math.max(0, w.pendingChapters - 1);
        w.executableChapters = Math.max(0, Math.min(w.executableChapters, w.pendingChapters));
        const workCompleted = w.pendingChapters === 0;
        this.reconcile();
        return { workCompleted, newCohort: [...this.cohortIds] };
    }
    /** Marks a work's remaining P1 routes externally blocked WITHOUT deleting its pending chapters. */
    markExternallyBlocked(workId, reason) {
        const w = this.works.get(workId);
        if (w) {
            w.externallyBlocked = true;
            w.executableChapters = 0;
            w.runningChapters = 0;
            w.blockReason = reason;
        }
        return this.reconcile().p2GateState;
    }
    /** Atomic gate for normal P2 new-work batch creation (max 10, paused immediately after enqueueing into P0+P1). */
    tryAdmitNormalP2Batch(newWorks, maxBatchSize = 10) {
        const check = this.reconcile();
        if (check.p2GateState === 'PAUSED_P1_BUSY') {
            return {
                admitted: false,
                gateState: 'PAUSED_P1_BUSY',
                enrolledWorkIds: [],
                reason: 'PAUSED_P1_BUSY: P1 has executable works; normal P2 discovery suspended',
            };
        }
        const capped = newWorks.slice(0, Math.min(10, maxBatchSize));
        if (capped.length === 0) {
            return {
                admitted: false,
                gateState: check.p2GateState,
                enrolledWorkIds: [],
                reason: 'EMPTY_P2_CANDIDATES',
            };
        }
        const enrolledWorkIds = [];
        for (const nw of capped) {
            this.works.set(nw.workId, { ...nw });
            enrolledWorkIds.push(nw.workId);
        }
        const afterState = this.reconcile().p2GateState;
        return {
            admitted: true,
            gateState: afterState,
            enrolledWorkIds,
            reason: `ADMITTED_P2_BATCH(${enrolledWorkIds.length}) -> P0+P1 enrolled -> ${afterState}`,
        };
    }
    /** Authenticated and auditable STAFF new-work exception: bypasses normal P2 lock, executes at STAFF (< P0). */
    admitStaffOnboarding(auth, work) {
        if (!auth.authenticated || !auth.staffUserId.trim() || !auth.auditReason.trim()) {
            throw new Error('UNAUTHORIZED_STAFF_ONBOARDING_REQUEST');
        }
        this.staffAuditLog.push({
            staffUserId: auth.staffUserId,
            auditReason: auth.auditReason,
            workKey: `work:${work.workId}`,
            at: new Date().toISOString(),
        });
        this.works.set(work.workId, { ...work });
        this.reconcile();
        return {
            admitted: true,
            assignedPriority: 'STAFF',
            reason: `STAFF_EXCEPTION_AUDIT:${auth.staffUserId}`,
        };
    }
    /** Re-habilita uma obra anteriormente bloqueada externamente quando a rota/fonte voltar a responder. */
    unblockWork(workId, executableChapters, pendingChapters) {
        const existing = this.works.get(workId);
        if (existing) {
            existing.externallyBlocked = false;
            existing.blockReason = null;
            if (executableChapters !== undefined)
                existing.executableChapters = executableChapters;
            if (pendingChapters !== undefined)
                existing.pendingChapters = pendingChapters;
        }
        return this.reconcile().p2GateState;
    }
    chapterLifecycle = new Map();
    /** Registra estado durável de ciclo de vida de capítulo individual (evita falsa conclusão de obra). */
    recordChapterLifecycle(workId, chapterKey, state, reason = null) {
        this.chapterLifecycle.set(`${workId}::${chapterKey}`, {
            workId,
            chapterKey,
            state,
            updatedAt: new Date().toISOString(),
            reason,
        });
    }
    /** Verifica conclusão real da obra confrontando fila ativa + estados individuais dos capítulos. */
    verifyWorkCompletion(workId) {
        const work = this.works.get(workId);
        const records = [...this.chapterLifecycle.values()].filter((r) => r.workId === workId);
        let publishedVerifiedCount = 0;
        let pendingOrActiveCount = 0;
        let blockedCount = 0;
        let inconsistentCount = 0;
        for (const r of records) {
            if (r.state === 'PUBLISHED_VERIFIED')
                publishedVerifiedCount += 1;
            else if (r.state === 'FAILED_BLOCKED')
                blockedCount += 1;
            else if (r.state === 'ORPHANED_OR_INCONSISTENT')
                inconsistentCount += 1;
            else
                pendingOrActiveCount += 1;
        }
        const queuePending = work ? (work.pendingChapters + work.executableChapters + work.runningChapters) : 0;
        const completed = queuePending === 0 &&
            !work?.externallyBlocked &&
            pendingOrActiveCount === 0 &&
            blockedCount === 0 &&
            inconsistentCount === 0 &&
            (!work || work.totalManifestChapters === 0 || work.publishedChapters >= work.totalManifestChapters || publishedVerifiedCount >= work.totalManifestChapters);
        return {
            workId,
            completed,
            queuePending,
            publishedVerifiedCount,
            pendingOrActiveCount,
            blockedCount,
            inconsistentCount,
            externallyBlocked: Boolean(work?.externallyBlocked),
        };
    }
}
